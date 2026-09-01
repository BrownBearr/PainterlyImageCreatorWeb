'use strict';

// ─── Algorithm: Hertzmann 2001 — Paint By Relaxation ─────────────────────────
// Same curved strokes as Hertzmann 1998, but stroke placement is an
// optimization rather than a threshold test. The paper defines an energy over
// the painting
//
//     E = E_app + E_area
//       = SUM_pixels || Lab(canvas) - Lab(reference) ||  +  w_area * SUM_strokes area
//
// and searches for a painting that minimizes it, instead of "paint wherever the
// cell error exceeds T". The practical difference is large: the 1998 rule paints
// a stroke whenever a region *looks* wrong, even when the stroke it is about to
// lay down does not actually make it better. Here a stroke is drawn only if it
// pays for itself.
//
// Because the energy is separable over pixels, the change in energy from one
// candidate stroke can be evaluated exactly over just that stroke's footprint,
// without rendering it:
//
//     dE = SUM_covered ( ||Lab(blended) - Lab(ref)|| - ||Lab(canvas) - Lab(ref)|| )
//        + w_area * SUM_covered alpha
//
// Accept iff dE < 0. Rearranged, a stroke is accepted when its mean Lab
// improvement per unit of covered area exceeds w_area — so `relaxAreaWeight` is
// directly "how much better must a stroke make things to be worth painting".
//
// Deviations from the paper (documented per repo convention):
// - The paper's relaxation also *removes* and *relocates* already-painted
//   strokes. Compositing onto a single canvas is not invertible, so removal is
//   not available here. Instead the search runs several passes over the layer;
//   each pass sees the accumulated canvas, so it is coordinate descent on the
//   same energy, and strokes that would not help are simply never added.
// - Relocation is approximated by trying `relaxTrials` jittered candidates per
//   grid cell and keeping the best-scoring one.
// - The energy is evaluated against the solid capsule footprint. Brush texture
//   and dry-brush modulate the actual composite, so with those enabled the
//   estimate is approximate (it stays a lower bound on coverage).
// - The 'blur' underpainting is treated as 'average', because starting from a
//   blurred copy of the source puts the canvas at a near-optimal energy already
//   and suppresses essentially every stroke.
//
// Loaded by worker.js via importScripts; relies on worker.js globals:
// mulberry32, shuffleArray, applyUnderpaint, gaussianBlurRGB, buildLabBuffer,
// computeErrorMap,
// strokeDirectionField, makeCurvedStroke, finalizeStrokeColor, getStrokeTexture,
// rgbToLab.

// Squared-free Lab distance between an RGB triple and a prepared Lab pixel.
function relaxLabDist(r, g, b, labRef, li) {
  const lab = rgbToLab(r, g, b);
  const dL = lab[0] - labRef[li], dA = lab[1] - labRef[li + 1], dB = lab[2] - labRef[li + 2];
  return Math.sqrt(dL * dL + dA * dA + dB * dB);
}

// Footprint of a stroke, clipped to the canvas.
function relaxBBox(pts, radius, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0], y = pts[i][1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const pad = radius + 1;
  return {
    x0: Math.max(0, Math.floor(minX - pad)), x1: Math.min(w - 1, Math.ceil(maxX + pad)),
    y0: Math.max(0, Math.floor(minY - pad)), y1: Math.min(h - 1, Math.ceil(maxY + pad)),
  };
}

// Scratch coverage mask, reused across evaluations. The search runs several
// candidates per grid cell per pass, so allocating one per evaluation would
// dominate. Single-threaded, so a module-level buffer is safe.
let _relaxMask = new Float32Array(0);

// Rasterize the stroke's coverage into the scratch mask, exactly as
// renderStrokeSolid does: walk each segment's own bounding box and keep the
// max coverage. Doing it per segment is what makes this affordable — testing
// every pixel of the whole stroke against every segment is O(area x segments),
// and a 16-step stroke has 16 segments.
function relaxFillMask(pts, radius, bx0, by0, bw, bh) {
  const need = bw * bh;
  if (_relaxMask.length < need) _relaxMask = new Float32Array(need);
  const mask = _relaxMask;
  mask.fill(0, 0, need);

  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0], ay = pts[i][1];
    const bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    const sx0 = Math.max(bx0, Math.floor(Math.min(ax, bx) - radius - 1));
    const sx1 = Math.min(bx0 + bw - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
    const sy0 = Math.max(by0, Math.floor(Math.min(ay, by) - radius - 1));
    const sy1 = Math.min(by0 + bh - 1, Math.ceil(Math.max(ay, by) + radius + 1));

    for (let py = sy0; py <= sy1; py++) {
      for (let px = sx0; px <= sx1; px++) {
        let d;
        if (lenSq < 1e-12) {
          d = Math.hypot(px - ax, py - ay);
        } else {
          let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        const cov = Math.max(0, Math.min(1, radius - d + 0.5));
        const mi = (py - by0) * bw + (px - bx0);
        if (cov > mask[mi]) mask[mi] = cov;
      }
    }
  }
  return mask;
}

// Energy delta for painting this stroke onto the live canvas. Exact: it
// composites the same coverage renderStrokeSolid will.
//
// `errBuf` holds the current per-pixel Lab distance to the reference, so the
// "before" term is a lookup rather than a second sRGB->Lab conversion — the
// transcendental work is what dominates, and this halves it.
function relaxStrokeDelta(env, labRef, errBuf, pts, radius, color, opacity, wArea) {
  const { canvasRGB, w, h } = env;
  const [sr, sg, sb] = color;
  const { x0, x1, y0, y1 } = relaxBBox(pts, radius, w, h);
  if (x1 < x0 || y1 < y0) return { dE: Infinity, area: 0 };

  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const mask = relaxFillMask(pts, radius, x0, y0, bw, bh);

  // Strokes with real interior are scored on a 2x lattice and scaled back up.
  // The decision is a sum over hundreds of covered pixels, so a quarter of the
  // samples estimates it closely at a quarter of the cost — and the cost here
  // is an sRGB->Lab conversion per sample, which is the whole expense of the
  // search. Thin strokes (radius < 3) are nearly all edge, where subsampling
  // would be noisy, so they are scored exactly.
  const step = radius >= 3 ? 2 : 1;
  const scale = step * step;

  let dErr = 0, area = 0;
  for (let py = y0; py <= y1; py += step) {
    for (let px = x0; px <= x1; px += step) {
      const a = mask[(py - y0) * bw + (px - x0)] * opacity;
      if (a <= 0) continue;
      const ci = (py * w + px) * 3;
      const cr = canvasRGB[ci], cg = canvasRGB[ci + 1], cb = canvasRGB[ci + 2];
      dErr += relaxLabDist(cr * (1 - a) + sr * a, cg * (1 - a) + sg * a, cb * (1 - a) + sb * a, labRef, ci)
            - errBuf[py * w + px];
      area += a;
    }
  }
  return { dE: (dErr + wArea * area) * scale, area: area * scale };
}

// Refresh the cached per-pixel error over a stroke's footprint after it has
// actually been composited by the sink.
function relaxRefreshErr(env, labRef, errBuf, pts, radius) {
  const { canvasRGB, w, h } = env;
  const { x0, x1, y0, y1 } = relaxBBox(pts, radius, w, h);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const ci = (py * w + px) * 3;
      errBuf[py * w + px] = relaxLabDist(canvasRGB[ci], canvasRGB[ci + 1], canvasRGB[ci + 2], labRef, ci);
    }
  }
}

function paintRelaxation(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, onProgress, brushTex, detailMap, sink } = env;
  const { maxStrokeLength, minStrokeLength, curvature, opacity, gridFactor,
          impastoStrength = 0, dryBrushAmount = 0,
          sizeJitter = 0, angleJitter = 0, opacityJitter = 0,
          relaxPasses = 2, relaxTrials = 2, relaxAreaWeight = 5 } = params;
  const rand = mulberry32(0x9A17E5 ^ (params.seed | 0));

  // Relaxation needs a neutral ground, not an approximation of the target. With
  // the blurred-source underpainting the canvas already sits near the reference,
  // so almost no stroke can pay for its own area and the result is the blur with
  // a few marks on it — technically the energy minimum, visually not a painting.
  // 'blur' is therefore treated as 'average' here; 'none' (white paper) still
  // works and gives a sparser, more drawn look.
  const underMode = (params.underpaintMode ?? 'blur') === 'blur' ? 'average' : params.underpaintMode;
  applyUnderpaint({ ...env, params: { ...params, underpaintMode: underMode } });

  const nLayers = radii.length;
  for (let ri = 0; ri < nLayers; ri++) {
    const radius = Math.max(1, Math.round(radii[ri]));
    const sigma = Math.max(0.1, radius * 0.5);

    const refBlur = gaussianBlurRGB(srcRGB, w, h, sigma);
    const labRef = buildLabBuffer(refBlur, w, h);
    const { gx, gy, gmag } = strokeDirectionField(refBlur, w, h, params);

    // Live per-pixel error against this layer's reference. Kept up to date as
    // strokes land so the search never re-derives the "before" term.
    const errBuf = computeErrorMap(labRef, buildLabBuffer(canvasRGB, w, h), w, h);

    const grid = Math.max(1, Math.round(radius * gridFactor));
    const cells = [];
    for (let y0 = 0; y0 < h; y0 += grid) {
      for (let x0 = 0; x0 < w; x0 += grid) cells.push([x0, y0]);
    }

    const passes = Math.max(1, Math.round(relaxPasses));
    const trials = Math.max(1, Math.round(relaxTrials));

    for (let pass = 0; pass < passes; pass++) {
      // Reshuffle every pass: a fixed order would bias which overlapping
      // candidate wins, and the shuffle is part of the seeded stream.
      shuffleArray(cells, rand);

      for (const [cx0, cy0] of cells) {
        const cx1 = Math.min(w, cx0 + grid), cy1 = Math.min(h, cy0 + grid);

        // Detail map lowers the bar for accepting a stroke where detail is
        // wanted, mirroring how it lowers T in the 1998 path.
        const cellWArea = detailMap
          ? relaxAreaWeight * (1 - detailMap[Math.min(h - 1, cy0) * w + Math.min(w - 1, cx0)])
          : relaxAreaWeight;

        // Pruning. A stroke can at best drive a pixel's error to zero, so the
        // improvement available at a pixel is bounded by its current error. If
        // every pixel in this cell is already closer to the reference than the
        // area price, no stroke centred here can pay for itself. Skipping those
        // cells outright is what makes the search affordable: by the finest
        // layer most of the canvas has converged, and evaluating the energy
        // costs a Lab conversion per covered pixel.
        //
        // Heuristic rather than a strict bound, since a stroke's footprint
        // extends beyond the cell it is seeded in.
        let cellMax = 0;
        for (let cy = cy0; cy < cy1; cy++) {
          for (let cx = cx0; cx < cx1; cx++) {
            const e = errBuf[cy * w + cx];
            if (e > cellMax) cellMax = e;
          }
        }
        if (cellMax < cellWArea) continue;

        let best = null;
        for (let t = 0; t < trials; t++) {
          const sx = Math.min(cx1 - 1, cx0 + Math.floor(rand() * (cx1 - cx0)));
          const sy = Math.min(cy1 - 1, cy0 + Math.floor(rand() * (cy1 - cy0)));

          const strokeRadius = Math.max(1, Math.round(radius * (1 + (rand() * 2 - 1) * sizeJitter)));
          const strokeOpacity = Math.max(0, Math.min(1, opacity * (1 + (rand() * 2 - 1) * opacityJitter)));

          const { pts, color } = makeCurvedStroke(
            sx, sy, strokeRadius, refBlur, canvasRGB, gx, gy, gmag, w, h,
            { maxLen: maxStrokeLength, minLen: minStrokeLength, curvature, angleJitter, rand }
          );
          if (pts.length < 2) continue;

          const strokeColor = finalizeStrokeColor(color[0], color[1], color[2], params, palette, rand);

          const { dE } = relaxStrokeDelta(env, labRef, errBuf, pts, strokeRadius, strokeColor, strokeOpacity, cellWArea);

          if (!best || dE < best.dE) {
            best = { dE, pts, radius: strokeRadius, color: strokeColor, opacity: strokeOpacity, sx, sy };
          }
        }

        // Only paint when the stroke actually lowers the energy.
        if (!best || best.dE >= 0) continue;

        sink.emit({
          pts: best.pts, radius: best.radius, color: best.color, opacity: best.opacity, layer: ri,
          tex: getStrokeTexture(brushTex, ri, best.sx, best.sy),
          dryBrush: dryBrushAmount, height: impastoStrength,
        });
        relaxRefreshErr(env, labRef, errBuf, best.pts, best.radius);
      }

      onProgress((ri + (pass + 1) / passes) / nLayers);
    }
  }
  onProgress(1);
}
