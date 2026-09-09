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
// Cost model, because it drives the defaults: the search evaluates
// `relaxPasses * relaxTrials` candidate strokes in every grid cell that is not
// pruned, and paints roughly one stroke per hundred it evaluates. Everything
// expensive scales with that product, so it is the first knob to reach for when
// a render is too slow — and the last one to raise when it is not good enough.
//
// Deviations from the paper (documented per repo convention):
// - The paper's relaxation also *removes* and *relocates* already-painted
//   strokes. Compositing onto a single canvas is not invertible, so removal is
//   not available here. Instead the search can run several passes over the
//   layer; each pass sees the accumulated canvas, so it is coordinate descent
//   on the same energy, and strokes that would not help are simply never added.
//   `relaxPasses` defaults to 1: on a 640x360 photo the second pass cost 48% of
//   all candidate evaluations to add 5% more strokes and 1% less Lab error, so
//   it is off unless asked for. The `deliberate` and `economical` presets do
//   ask for it.
// - Relocation is approximated by trying `relaxTrials` jittered candidates per
//   grid cell and keeping the best-scoring one. This one earns its keep and
//   stays at 2 by default.
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

// sRGB companding, tabulated. The gamma curve is the only transcendental in
// the conversion that is a function of one channel alone, so it tabulates
// exactly once and is read three times per pixel instead of calling Math.pow.
//
// 16384 entries with linear interpolation: the curve's second derivative peaks
// near 3, so the interpolation error is bounded by h^2 * f'' / 8 ~ 1e-9 in
// linear-light units, which reaches L* at roughly 3e-7 — some four orders of
// magnitude below the last bit of the 8-bit channels this is all quantized
// into, and seven below the Lab distances being compared.
//
// It is not bit-identical to Math.pow, so in principle a candidate sitting
// within 1e-7 of dE == 0 could fall the other way. Nothing observed does: every
// committed baseline is unchanged, and a sweep of 3 image sizes x 6 seeds x 2
// underpaintings rendered byte-for-byte identically against the Math.pow
// version. A stroke that marginal changes nothing anyone can see either way.
const RELAX_GAMMA_N = 16384;
const RELAX_GAMMA_LUT = (() => {
  const lut = new Float64Array(RELAX_GAMMA_N + 2);
  for (let i = 0; i <= RELAX_GAMMA_N + 1; i++) {
    const v = (i / RELAX_GAMMA_N) * (255 / 255);
    lut[i] = v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  }
  return lut;
})();
const RELAX_GAMMA_SCALE = RELAX_GAMMA_N / 255;

function relaxGamma(c) {
  let u = c * RELAX_GAMMA_SCALE;
  if (!(u > 0)) return RELAX_GAMMA_LUT[0];              // also catches NaN
  if (u > RELAX_GAMMA_N) u = RELAX_GAMMA_N;
  const i = u | 0;
  const f = u - i;
  const a = RELAX_GAMMA_LUT[i];
  return a + (RELAX_GAMMA_LUT[i + 1] - a) * f;
}

// Lab distance between an RGB triple and a prepared Lab pixel.
//
// This is the innermost operation of the whole search — one call per covered
// pixel per candidate stroke — so rgbToLab is inlined rather than called. What
// that avoids is the three-element array rgbToLab returns, which was being
// allocated and thrown away millions of times per render.
function relaxLabDist(r, g, b, labRef, li) {
  r = relaxGamma(r); g = relaxGamma(g); b = relaxGamma(b);

  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y =  r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;

  const fX = X > 0.008856 ? Math.cbrt(X) : 7.787 * X + 16 / 116;
  const fY = Y > 0.008856 ? Math.cbrt(Y) : 7.787 * Y + 16 / 116;
  const fZ = Z > 0.008856 ? Math.cbrt(Z) : 7.787 * Z + 16 / 116;

  const dL = (116 * fY - 16) * 255 / 100 - labRef[li];
  const dA = 500 * (fX - fY) + 128 - labRef[li + 1];
  const dB = 200 * (fY - fZ) + 128 - labRef[li + 2];
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
// dominate. Single-threaded, so module-level buffers are safe.
//
// The mask is image-sized and indexed globally, paired with a generation stamp:
// a pixel counts as covered only if its stamp matches the current stroke's
// generation. That makes clearing free — bumping the counter invalidates the
// whole mask — where a per-candidate `fill(0)` was memsetting the stroke's
// bounding box (tens of KB) for every candidate, accepted or not.
//
// `_relaxTouched` lists the pixels this stroke actually covers, so callers that
// do not care about traversal order can iterate the footprint instead of the
// bounding box. For a curved stroke the box is several times the capsule.
let _relaxMask = new Float32Array(0);
let _relaxStamp = new Int32Array(0);
let _relaxTouched = new Int32Array(0);
let _relaxNTouched = 0;
let _relaxGen = 0;

// Called once per render. The generation counter restarts every time and the
// stamps are cleared to match, which keeps it far inside Int32 range: it
// advances once per candidate stroke, and a render evaluates on the order of
// 1e5. Letting it run across renders would reach 2^31 partway through a long
// video export, and a wrapped stamp never matches its generation, so every
// pixel would read as untouched — coverage silently overwritten instead of
// maxed, and the touched list overrunning its bound.
function relaxEnsureScratch(w, h) {
  const need = w * h;
  if (_relaxMask.length < need) {
    _relaxMask = new Float32Array(need);
    _relaxStamp = new Int32Array(need);
    _relaxTouched = new Int32Array(need);
  } else {
    _relaxStamp.fill(0);
  }
  _relaxGen = 0;
}

// Rasterize the stroke's coverage into the scratch mask, exactly as
// renderStrokeSolid does: walk each segment's own bounding box and keep the
// max coverage. Doing it per segment is what makes this affordable — testing
// every pixel of the whole stroke against every segment is O(area x segments),
// and a 16-step stroke has 16 segments.
//
// Coverage is `clamp(radius - d + 0.5, 0, 1)`, so it is exactly 1 inside
// radius-0.5, exactly 0 outside radius+0.5, and only varies in the one-pixel
// band between. Comparing the *squared* distance against those two radii
// resolves the interior and the exterior — the large majority of every
// segment's box — without a square root, which is what the distance actually
// cost. `sqrt(fl(x*x)) === x` under round-to-nearest, so the squared test
// agrees with the unsquared one bit for bit.
// `step`/`ox`/`oy` restrict the rasterization to the lattice the caller will
// actually read: the energy is scored on a 2x lattice for thick strokes, so
// filling every pixel produced four times the coverage anyone consumed.
function relaxFillMask(pts, radius, w, h, step = 1, ox = 0, oy = 0) {
  const gen = ++_relaxGen;
  const mask = _relaxMask, stamp = _relaxStamp, touched = _relaxTouched;
  let nTouched = 0;

  const rIn = radius - 0.5, rOut = radius + 0.5;
  const rInSq = rIn * rIn, rOutSq = rOut * rOut;

  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0], ay = pts[i][1];
    const bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const degenerate = lenSq < 1e-12;

    let sx0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
    const sx1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
    let sy0 = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
    const sy1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + radius + 1));
    if (step > 1) {
      sx0 += (((ox - sx0) % step) + step) % step;
      sy0 += (((oy - sy0) % step) + step) % step;
    }

    // Per-row span. A covered pixel on row py has its closest point on the
    // segment within rOut, so that point's own y is within rOut of py — which
    // pins it to a sub-range of the segment, and the pixel to within rOut of
    // that sub-range's x-extent. For a diagonal segment the sub-range is short
    // and the span is far narrower than the row of the bounding box, which is
    // where the wasted visits were: a thin stroke crossing a fat box corner to
    // corner rejected most of what it touched. Costs a handful of adds per row
    // and no square root, and it is a superset of the covered set, so the
    // distance test below still decides every pixel.
    const invDy = degenerate || dy === 0 ? 0 : 1 / dy;

    for (let py = sy0; py <= sy1; py += step) {
      let lo, hi;
      if (invDy === 0) {
        const dya = py - ay;
        if (dya * dya > rOutSq && !degenerate) {
          // Horizontal segment: rows beyond the radius cannot be covered.
          if (Math.abs(py - by) > rOut) continue;
        }
        lo = Math.min(ax, bx) - rOut; hi = Math.max(ax, bx) + rOut;
      } else {
        let t0 = (py - ay - rOut) * invDy, t1 = (py - ay + rOut) * invDy;
        if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
        if (t1 < 0 || t0 > 1) continue;                    // segment never reaches this row
        if (t0 < 0) t0 = 0;
        if (t1 > 1) t1 = 1;
        const xa = ax + t0 * dx, xb = ax + t1 * dx;
        lo = (xa < xb ? xa : xb) - rOut;
        hi = (xa < xb ? xb : xa) + rOut;
      }
      // floor/ceil leaves a pixel of margin, so a rounding wobble in the span
      // can never drop a pixel the distance test would have covered.
      let px0i = Math.max(sx0, Math.floor(lo));
      const px1i = Math.min(sx1, Math.ceil(hi));
      if (step > 1) px0i += (((ox - px0i) % step) + step) % step;

      const row = py * w;
      for (let px = px0i; px <= px1i; px += step) {
        let ex, ey;
        if (degenerate) {
          ex = px - ax; ey = py - ay;
        } else {
          let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          ex = px - (ax + t * dx); ey = py - (ay + t * dy);
        }
        const dsq = ex * ex + ey * ey;
        if (dsq >= rOutSq) continue;                       // coverage is exactly 0

        const mi = row + px;
        const fresh = stamp[mi] !== gen;
        // A saturated pixel cannot be raised by a later segment.
        if (!fresh && mask[mi] >= 1) continue;

        let cov;
        if (dsq <= rInSq) cov = 1;                         // coverage is exactly 1
        else cov = Math.max(0, Math.min(1, radius - Math.sqrt(dsq) + 0.5));

        if (fresh) {
          stamp[mi] = gen;
          mask[mi] = cov;
          touched[nTouched++] = mi;
        } else if (cov > mask[mi]) {
          mask[mi] = cov;
        }
      }
    }
  }
  _relaxNTouched = nTouched;
  return gen;
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

  // Strokes with real interior are scored on a 2x lattice and scaled back up.
  // The decision is a sum over hundreds of covered pixels, so a quarter of the
  // samples estimates it closely at a quarter of the cost — and the cost here
  // is an sRGB->Lab conversion per sample, which is the whole expense of the
  // search. Thin strokes (radius < 3) are nearly all edge, where subsampling
  // would be noisy, so they are scored exactly.
  const step = radius >= 3 ? 2 : 1;
  const scale = step * step;

  const gen = relaxFillMask(pts, radius, w, h, step, x0, y0);

  // Reject without touching Lab where the stroke provably cannot pay.
  //
  // The best a stroke can do at a pixel is drive its error to zero, so
  //
  //     dE  =  SUM ( err_after - err_before + wArea * a )
  //         >= SUM ( wArea * a - err_before )
  //
  // and when that bound is already >= 0 the candidate cannot lower the energy.
  // It is then rejected outright, which is exactly what the full evaluation
  // would have done: a stroke is painted only when the best of the trials has
  // dE < 0, so a candidate known to be >= 0 can never be the one painted, nor
  // displace one that is. Both terms are plain buffer reads, roughly an order
  // of magnitude cheaper than the sRGB->Lab conversion per sample this skips —
  // and 99% of candidates are rejected.
  const mask = _relaxMask, touched = _relaxTouched, nTouched = _relaxNTouched;
  let bound = 0;
  for (let k = nTouched - 1; k >= 0; k--) {
    const mi = touched[k];
    bound += wArea * mask[mi] * opacity - errBuf[mi];
  }
  if (bound >= 0) return { dE: Infinity, area: 0 };

  // Walks the covered-pixel list rather than the bounding-box lattice. The two
  // visit exactly the same pixels; the box additionally visits everything
  // around the stroke, which for a thin stroke across a large box was most of
  // the iterations. The sum is a float accumulation, so the different traversal
  // order rounds differently in the last bits — far below any accept margin
  // that means anything, and the committed baselines are unchanged by it.
  let dErr = 0, area = 0;
  for (let k = 0; k < nTouched; k++) {
    const mi = touched[k];
    const a = mask[mi] * opacity;
    if (a <= 0) continue;
    const ci = mi * 3;
    const cr = canvasRGB[ci], cg = canvasRGB[ci + 1], cb = canvasRGB[ci + 2];
    dErr += relaxLabDist(cr * (1 - a) + sr * a, cg * (1 - a) + sg * a, cb * (1 - a) + sb * a, labRef, ci)
          - errBuf[mi];
    area += a;
  }
  return { dE: (dErr + wArea * area) * scale, area: area * scale };
}

// Refresh the cached per-pixel error over a stroke's footprint after it has
// actually been composited by the sink.
//
// Only the pixels the stroke covers can have changed — the sink composites the
// same capsule union this mask holds, and brush texture, dry-brush and impasto
// only attenuate coverage inside it — so the refresh walks the touched list
// rather than the bounding box. Each entry costs an sRGB->Lab conversion, and a
// curved stroke's box holds several times as many pixels as its footprint.
//
// The stroke is re-rasterized here rather than reusing the scratch: the winning
// candidate is not generally the last one evaluated. Coverage is cheap now that
// it costs no square roots; the Lab conversions are the expense.
function relaxRefreshErr(env, labRef, errBuf, pts, radius) {
  const { canvasRGB, w, h } = env;
  relaxFillMask(pts, radius, w, h);
  const touched = _relaxTouched, n = _relaxNTouched;
  for (let k = 0; k < n; k++) {
    const mi = touched[k];
    const ci = mi * 3;
    errBuf[mi] = relaxLabDist(canvasRGB[ci], canvasRGB[ci + 1], canvasRGB[ci + 2], labRef, ci);
  }
}

function paintRelaxation(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, onProgress, brushTex, detailMap, sink } = env;
  const { maxStrokeLength, minStrokeLength, curvature, opacity, gridFactor,
          impastoStrength = 0, dryBrushAmount = 0,
          sizeJitter = 0, angleJitter = 0, opacityJitter = 0,
          relaxPasses = 1, relaxTrials = 2, relaxAreaWeight = 5 } = params;
  const rand = mulberry32(0x9A17E5 ^ (params.seed | 0));
  relaxEnsureScratch(w, h);

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
