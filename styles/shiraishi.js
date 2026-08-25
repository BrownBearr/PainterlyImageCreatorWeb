'use strict';

// ─── Algorithm: Shiraishi & Yamaguchi 2000 — strokes by image moments ─────────
// "An Algorithm for Automatic Painterly Rendering Based on Local Source Image
// Approximation": rectangular strokes fitted to local regions. For each stroke
// seed, a local color-similarity image is built around the seed and its
// second-order moments give the equivalent rectangle's center, orientation,
// length and width — so stroke shape follows the region it covers.
//
// Deviations from the paper (documented per repo convention):
// - Strokes rasterize as capsules (rounded ends) through the shared sink
//   rather than sharp rectangles, to keep one rasterizer.
// - Seed placement dithers the importance image with Floyd–Steinberg
//   (deterministic), then jitters positions with the seeded RNG so the seed
//   parameter produces distinct paintings.
// - Colors sample the layer-blurred source (repo convention), not raw source.
//
// Loaded by worker.js via importScripts; relies on worker.js globals:
// mulberry32, applyUnderpaint, gaussianBlurRGB, buildLabBuffer,
// computeErrorMap, finalizeStrokeColor, getStrokeTexture.

function paintShiraishi(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, onProgress, brushTex, sink } = env;
  const { gridFactor, opacity, impastoStrength = 0 } = params;
  const rand = mulberry32(0x51DA15 ^ (params.seed | 0));

  applyUnderpaint(env);

  // Color-similarity cutoff: RGB distance at which a neighbor stops counting
  // as part of the stroke's region.
  const SIM_T = 80;

  for (let ri = 0; ri < radii.length; ri++) {
    const S = Math.max(2, Math.round(radii[ri]));
    const refBlur = gaussianBlurRGB(srcRGB, w, h, Math.max(0.5, S * 0.5));

    // Importance image: uniform on the first layer, then the Lab error of the
    // live canvas vs the source so refinement layers focus on bad regions.
    const targetN = Math.max(1, Math.round((w * h) / Math.pow(Math.max(1, S * gridFactor), 2)));
    let importance;
    if (ri === 0) {
      importance = new Float32Array(w * h).fill(targetN / (w * h));
    } else {
      const err = computeErrorMap(buildLabBuffer(refBlur, w, h), buildLabBuffer(canvasRGB, w, h), w, h);
      let sum = 0;
      for (let i = 0; i < err.length; i++) sum += err[i];
      if (sum <= 1e-6) { onProgress((ri + 1) / radii.length); continue; }
      const k = targetN / sum;
      importance = err; // reuse the buffer
      for (let i = 0; i < importance.length; i++) importance[i] = Math.min(1, importance[i] * k);
    }

    // Floyd–Steinberg dither of the importance image → stroke seed points.
    // Deterministic raster order; the seeded jitter below decorrelates seeds.
    const seeds = [];
    const errRow = new Float32Array(importance); // dither in place on a copy
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = errRow[i];
        const on = v >= 0.5 ? 1 : 0;
        if (on) seeds.push(i);
        const e = v - on;
        if (x + 1 < w) errRow[i + 1] += e * 7 / 16;
        if (y + 1 < h) {
          if (x > 0) errRow[i + w - 1] += e * 3 / 16;
          errRow[i + w] += e * 5 / 16;
          if (x + 1 < w) errRow[i + w + 1] += e * 1 / 16;
        }
      }
    }

    // Fit one stroke per seed via moments of the local similarity image.
    const strokes = [];
    for (const si of seeds) {
      const px = Math.max(0, Math.min(w - 1, Math.round((si % w) + (rand() - 0.5) * S)));
      const py = Math.max(0, Math.min(h - 1, Math.round(((si / w) | 0) + (rand() - 0.5) * S)));
      const pi = (py * w + px) * 3;
      const pr = refBlur[pi], pg = refBlur[pi + 1], pb = refBlur[pi + 2];

      const x0 = Math.max(0, px - S), x1 = Math.min(w - 1, px + S);
      const y0 = Math.max(0, py - S), y1 = Math.min(h - 1, py + S);

      // Zeroth/first/second moments of D(q) = max(0, 1 - |C(q)-C(p)| / T),
      // with dx,dy relative to the seed.
      let m00 = 0, mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0;
      for (let qy = y0; qy <= y1; qy++) {
        for (let qx = x0; qx <= x1; qx++) {
          const qi = (qy * w + qx) * 3;
          const dr = refBlur[qi] - pr, dg = refBlur[qi + 1] - pg, db = refBlur[qi + 2] - pb;
          const d = Math.max(0, 1 - Math.sqrt(dr * dr + dg * dg + db * db) / SIM_T);
          if (d <= 0) continue;
          const dx = qx - px, dy = qy - py;
          m00 += d;
          mx += d * dx; my += d * dy;
          mxx += d * dx * dx; myy += d * dy * dy; mxy += d * dx * dy;
        }
      }
      if (m00 <= 1e-6) continue;

      const cx = px + mx / m00, cy = py + my / m00;
      // Central second moments (normalized)
      const u20 = mxx / m00 - (mx / m00) * (mx / m00);
      const u02 = myy / m00 - (my / m00) * (my / m00);
      const u11 = mxy / m00 - (mx / m00) * (my / m00);
      const theta = 0.5 * Math.atan2(2 * u11, u20 - u02);
      const tr = u20 + u02, det = Math.sqrt(Math.max(0, (u20 - u02) * (u20 - u02) + 4 * u11 * u11));
      const lamMax = (tr + det) / 2, lamMin = Math.max(0, (tr - det) / 2);
      // Equivalent rectangle: a uniform rectangle of half-length a has
      // normalized moment a²/3 → a = sqrt(3λ).
      const halfLen = Math.max(1, Math.min(2 * S, Math.sqrt(3 * lamMax)));
      const halfWidth = Math.max(1, Math.min(S, Math.sqrt(3 * lamMin)));

      // Paper: stroke color is the source color at the seed point.
      const color = finalizeStrokeColor(pr, pg, pb, params, palette, rand);
      strokes.push({ cx, cy, theta, halfLen, halfWidth, color, sx: px, sy: py });
    }

    // Paper ordering: larger strokes first so fine ones land on top.
    strokes.sort((a, b) => (b.halfLen * b.halfWidth) - (a.halfLen * a.halfWidth));

    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      const ext = Math.max(0, s.halfLen - s.halfWidth);
      const dx = Math.cos(s.theta), dy = Math.sin(s.theta);
      sink.emit({
        pts: [[s.cx - dx * ext, s.cy - dy * ext], [s.cx + dx * ext, s.cy + dy * ext]],
        radius: s.halfWidth, color: s.color, opacity, layer: ri,
        tex: getStrokeTexture(brushTex, ri, s.sx, s.sy),
        dryBrush: 0, height: impastoStrength,
      });
      if ((i & 511) === 0) onProgress((ri + i / strokes.length) / radii.length);
    }
    onProgress((ri + 1) / radii.length);
  }
}
