'use strict';

// ─── Algorithm: Bousseau et al. 2006 — interactive watercolor rendering ───────
// "Interactive Watercolor Rendering with Temporal Coherence and Abstraction":
// a two-phase pipeline. First the image is *abstracted* into flat color
// regions, then watercolor *effects* are expressed as modulations of a
// per-pixel pigment density d, applied with the paper's pigment model
//
//     C' = C − (C − C²)(d − 1)      C ∈ [0,1]
//
// so d = 1 leaves a pixel untouched, d > 1 darkens and saturates it (more
// pigment settled), and d < 1 lightens it. The effects implemented here are
// the paper's edge darkening (pigment migrating to the rim of a wash),
// turbulence flow (pigment density varying with a fractal noise field) and a
// light hand-painted wobble of region boundaries.
//
// Deviations from the paper (documented per repo convention):
// - Abstraction is a Gaussian blur plus optional palette snap (worker.js's
//   k-means palette), not the paper's §3 morphological segmentation. The
//   result is the same in spirit — large flat regions — without a segmenter.
// - On top of the abstracted washes we paint explicit translucent wash
//   strokes, so the style fits this app's stroke-based aesthetic and the
//   shared brush-texture / impasto machinery. The paper fills flat regions
//   directly.
// - Turbulence and wobble use a coordinate-hashed fractal value noise offset
//   by params.seed rather than a stored noise texture, so a video renders
//   frame-stable (the field depends only on x, y and the seed) while the seed
//   control still produces distinct paintings. The paper's §5 temporally
//   coherent noise advection is out of scope.
// - Watercolor is a wet medium, so wash strokes are only clipped at strong
//   edges (0.55 of max Sobel, vs Litwinowicz's 0.35) — washes are allowed to
//   bleed a little past a boundary.
//
// Loaded by worker.js via importScripts; relies on worker.js globals:
// mulberry32, shuffleArray, applyUnderpaint, gaussianBlurRGB, computeGradients,
// computeGradientsST, snapToPalette, finalizeStrokeColor, getStrokeTexture.

// ─── Seeded fractal value noise (coordinate-hashed ⇒ frame-stable) ────────────

function wcHash(xi, yi, s) {
  const n = Math.sin(xi * 127.1 + yi * 311.7 + s * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function wcValueNoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
  const a = wcHash(xi, yi, s), b = wcHash(xi + 1, yi, s);
  const c = wcHash(xi, yi + 1, s), d = wcHash(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Sum of octaves, normalized to [0,1].
function wcFbm(x, y, s, octaves) {
  let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * wcValueNoise(fx, fy, s + o * 17);
    norm += amp;
    amp *= 0.5; fx *= 2; fy *= 2;
  }
  return norm > 0 ? sum / norm : 0.5;
}

// Separable Gaussian blur of a single-channel field (worker.js only ships an
// RGB blur; the edge field is grayscale).
function wcBlurGray(src, w, h, sigma) {
  const { k, radius } = makeGaussKernel(Math.max(0.1, sigma));
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let d = -radius; d <= radius; d++) {
        const xx = Math.max(0, Math.min(w - 1, x + d));
        acc += src[y * w + xx] * k[d + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let d = -radius; d <= radius; d++) {
        const yy = Math.max(0, Math.min(h - 1, y + d));
        acc += tmp[yy * w + x] * k[d + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// ─── Wash density accumulation ────────────────────────────────────────────────
// Running total of per-stroke alpha over each wash's footprint. Its gradient is
// the boundary of the wet region, which is exactly where the paper's edge
// darkening deposits pigment — so rims land on the painted washes rather than
// on photographic detail. Capsule coverage matches renderStrokeSolid's
// distance-to-segment test (unantialiased: this only feeds a blurred gradient).
function wcAccumulateWash(field, w, h, pts, radius, alpha) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy);
        if (ex * ex + ey * ey <= radius * radius) field[py * w + px] += alpha;
      }
    }
  }
}

// ─── Phase C: Bousseau effect pass over the finished canvas ───────────────────

function applyWatercolorEffects(env, washDensity) {
  const { canvasRGB, w, h, params } = env;
  const edgeAmt = params.watercolorEdge || 0;
  const turbAmt = params.watercolorTurbulence || 0;
  const wobbleAmt = params.watercolorWobble || 0;
  if (edgeAmt <= 0 && turbAmt <= 0 && wobbleAmt <= 0) return;

  const s = params.seed | 0;

  // Wobble: resample the canvas through a low-frequency displacement field so
  // region boundaries meander like a hand-laid wash instead of tracking the
  // photograph exactly.
  if (wobbleAmt > 0) {
    const src = canvasRGB.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (wcFbm(x / 24, y / 24, s + 11, 2) - 0.5) * 2 * wobbleAmt;
        const dy = (wcFbm(x / 24, y / 24, s + 29, 2) - 0.5) * 2 * wobbleAmt;
        const sx = Math.max(0, Math.min(w - 1.001, x + dx));
        const sy = Math.max(0, Math.min(h - 1.001, y + dy));
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const tx = sx - x0, ty = sy - y0;
        const ci = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          const a = src[(y0 * w + x0) * 3 + c] * (1 - tx) + src[(y0 * w + x1) * 3 + c] * tx;
          const b = src[(y1 * w + x0) * 3 + c] * (1 - tx) + src[(y1 * w + x1) * 3 + c] * tx;
          canvasRGB[ci + c] = a * (1 - ty) + b * ty;
        }
      }
    }
  }

  // Edge darkening: as a wash dries, pigment migrates to its rim. The density
  // therefore rises along the gradient of the wash-density field — the outline
  // of each wet region. Softened into a band so it reads as a settled rim
  // rather than an inked outline.
  let edgeField = null;
  if (edgeAmt > 0 && washDensity) {
    const smooth = wcBlurGray(washDensity, w, h, 1.0);
    const grad = new Float32Array(w * h);
    let maxG = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
        const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
        const dxv = smooth[y * w + xp] - smooth[y * w + xm];
        const dyv = smooth[yp * w + x] - smooth[ym * w + x];
        const g = Math.sqrt(dxv * dxv + dyv * dyv);
        grad[y * w + x] = g;
        if (g > maxG) maxG = g;
      }
    }
    if (maxG > 1e-6) for (let i = 0; i < grad.length; i++) grad[i] /= maxG;
    edgeField = wcBlurGray(grad, w, h, 1.2);
    // Rims are narrow and high-contrast; the sqrt lifts the mid-range so the
    // band is visible without the strongest boundaries clipping to black.
    for (let i = 0; i < edgeField.length; i++) edgeField[i] = Math.sqrt(edgeField[i]);
  }

  // Apply the pigment density model per pixel.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = 1;
      if (edgeField) d += edgeAmt * edgeField[i];
      if (turbAmt > 0) {
        // Two scales: broad blooms where a wash pooled, plus fine granulation
        // where pigment settled into the paper's tooth.
        const broad = wcFbm(x / 40, y / 40, s + 3, 3) - 0.5;
        const fine = wcFbm(x / 9, y / 9, s + 53, 3) - 0.5;
        d += turbAmt * 2 * (broad * 0.6 + fine * 0.4);
      }
      if (d === 1) continue;
      const ci = i * 3;
      for (let c = 0; c < 3; c++) {
        const C = Math.max(0, Math.min(1, canvasRGB[ci + c] / 255));
        const out = C - (C - C * C) * (d - 1);
        canvasRGB[ci + c] = Math.max(0, Math.min(255, out * 255));
      }
    }
  }
}

// ─── Phases A + B: abstraction, then translucent wash strokes ─────────────────

function paintWatercolor(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, onProgress, brushTex, sink } = env;
  const { maxStrokeLength, minStrokeLength, gridFactor, opacity,
          impastoStrength = 0, dryBrushAmount = 0, tensorSigma = 0 } = params;
  const rand = mulberry32(0x2A7E4 ^ (params.seed | 0));

  // Phase A — abstraction. The default ('blur') is the paper's abstraction
  // step: heavily blur the source and, when a palette is active, snap every
  // pixel to it so the canvas starts as flat color regions. The other
  // underpainting modes fall through to the shared helper, so "None (white
  // canvas)" gives the classic build-up of transparent washes on bare paper.
  if ((params.underpaintMode ?? 'blur') === 'blur') {
    const abstracted = gaussianBlurRGB(srcRGB, w, h, Math.max(0.5, (radii[0] ?? 8) * 0.8));
    if (palette) {
      for (let i = 0; i < w * h; i++) {
        const c = snapToPalette(abstracted[i * 3], abstracted[i * 3 + 1], abstracted[i * 3 + 2], palette);
        canvasRGB[i * 3] = c[0]; canvasRGB[i * 3 + 1] = c[1]; canvasRGB[i * 3 + 2] = c[2];
      }
    } else {
      canvasRGB.set(abstracted);
    }
  } else {
    applyUnderpaint(env);
  }

  // Phase B — wash strokes, coarse → fine. Each layer lays broad, translucent
  // strokes oriented along the image structure; overlapping them is what builds
  // watercolor's characteristic layered depth. Washes are placed sparsely on
  // purpose: densely overlapping translucent strokes that all sample the same
  // reference just reconverge to that reference, and the layering disappears.
  const washDensity = new Float32Array(w * h);
  const nLayers = radii.length;
  const steps = nLayers + 1; // + the effect pass
  for (let ri = 0; ri < nLayers; ri++) {
    const radius = Math.max(1, Math.round(radii[ri]));
    // Sampled at a finer scale than the abstraction underneath, so each wash
    // carries more local color than the base it is laid over.
    const refBlur = gaussianBlurRGB(srcRGB, w, h, Math.max(0.5, radius * 0.35));

    const { gx, gy, gmag } = computeGradientsST(refBlur, w, h, tensorSigma > 0 ? tensorSigma : 2.0);
    const { gmag: edgeMag } = computeGradients(refBlur, w, h);
    let maxEdge = 0;
    for (let i = 0; i < edgeMag.length; i++) if (edgeMag[i] > maxEdge) maxEdge = edgeMag[i];
    const edgeThresh = 0.55 * maxEdge; // looser than Litwinowicz: washes bleed

    const spacing = Math.max(2, Math.round(radius * 2.5 * gridFactor));
    const centers = [];
    for (let y = 0; y < h; y += spacing) {
      for (let x = 0; x < w; x += spacing) {
        centers.push([
          Math.max(0, Math.min(w - 1, Math.round(x + (rand() - 0.5) * spacing))),
          Math.max(0, Math.min(h - 1, Math.round(y + (rand() - 0.5) * spacing))),
        ]);
      }
    }
    shuffleArray(centers, rand);

    for (const [cx, cy] of centers) {
      const idx = cy * w + cx;

      let theta = gmag[idx] > 1e-4 ? Math.atan2(gx[idx], -gy[idx]) : Math.PI / 4;
      theta += (rand() * 2 - 1) * 0.35; // washes are laid loosely
      const dx = Math.cos(theta), dy = Math.sin(theta);

      const targetLen = (minStrokeLength + rand() * Math.max(0, maxStrokeLength - minStrokeLength))
                      * (0.8 + rand() * 0.4);
      const half = Math.max(0.5, targetLen / 2);

      const march = (sx, sy) => {
        let px = cx, py = cy;
        for (let t = 1; t <= half; t++) {
          const nx = Math.round(cx + sx * t), ny = Math.round(cy + sy * t);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
          px = nx; py = ny;
          if (edgeMag[ny * w + nx] > edgeThresh) break;
        }
        return [px, py];
      };
      const p0 = march(-dx, -dy);
      const p1 = march(dx, dy);
      // Bow the stroke slightly off its chord so washes read as fluid.
      const wob = (rand() - 0.5) * radius * 0.9;
      const pm = [(p0[0] + p1[0]) / 2 - dy * wob, (p0[1] + p1[1]) / 2 + dx * wob];

      const base = finalizeStrokeColor(
        refBlur[idx * 3], refBlur[idx * 3 + 1], refBlur[idx * 3 + 2], params, palette, rand);

      // Pigment load: how much color this particular wash carries. Averages to
      // 1, so the painting keeps the source's overall value while individual
      // washes read as heavier or thinner — the mottling of overlapping passes.
      const load = 0.88 + rand() * 0.24;
      const color = [
        Math.max(0, Math.min(255, base[0] * load)),
        Math.max(0, Math.min(255, base[1] * load)),
        Math.max(0, Math.min(255, base[2] * load)),
      ];

      // Low alpha: watercolor is built from transparent passes.
      const washOpacity = Math.max(0.02, Math.min(1, opacity * 0.45 * (0.7 + rand() * 0.6)));

      const pts = [p0, pm, p1];
      sink.emit({
        pts, radius, color, opacity: washOpacity, layer: ri,
        tex: getStrokeTexture(brushTex, ri, cx, cy),
        dryBrush: dryBrushAmount, height: impastoStrength,
      });
      wcAccumulateWash(washDensity, w, h, pts, radius, washOpacity);
    }
    onProgress((ri + 1) / steps);
  }

  // Phase C — Bousseau effects over the finished washes.
  applyWatercolorEffects(env, washDensity);
  onProgress(1);
}
