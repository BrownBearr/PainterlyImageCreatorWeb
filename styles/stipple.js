'use strict';

// ─── Algorithm: Secord 2002 — weighted Voronoi stippling ──────────────────────
// "Weighted Voronoi Stippling": stipple dots distributed by Lloyd relaxation
// of a centroidal Voronoi diagram whose density is derived from image
// luminance (dark = dense). Dots are emitted through the shared sink with the
// `dot` fast path (no per-dot mask allocation).
//
// CPU implementation notes:
// - The density field and all Voronoi work run on a grid capped at 512 px on
//   the long side; sites live in grid coordinates and scale back up on emit.
// - Nearest-site assignment per Lloyd iteration uses jump flooding (JFA) with
//   ties broken toward the lower site id, so results are deterministic.
// - Ignores underpaintMode: stippling always starts from white paper.
//
// Loaded by worker.js via importScripts; relies on worker.js global mulberry32.

function paintStipple(env) {
  const { srcRGB, canvasRGB, w, h, params, onProgress, sink } = env;
  const rand = mulberry32(0x577DD1E ^ (params.seed | 0));

  const N = Math.max(16, Math.min(100000, Math.round(params.stipplePoints || 8000)));
  const iters = Math.max(0, Math.min(60, Math.round(params.stippleIters ?? 12)));
  const dotMin = Math.max(0.3, params.stippleDotMin || 1);
  const dotMax = Math.max(dotMin, params.stippleDotMax || 3);
  const invert = !!params.stippleInvert;
  const opacity = params.opacity ?? 1;

  canvasRGB.fill(255);

  // Density grid ρ from luminance, box-averaged down to ≤512 on the long side.
  const scale = Math.min(1, 512 / Math.max(w, h));
  const gw = Math.max(1, Math.round(w * scale));
  const gh = Math.max(1, Math.round(h * scale));
  const rho = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y * gh / h) | 0);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, (x * gw / w) | 0);
      const i3 = (y * w + x) * 3;
      const lum = (0.299 * srcRGB[i3] + 0.587 * srcRGB[i3 + 1] + 0.114 * srcRGB[i3 + 2]) / 255;
      rho[gy * gw + gx] += lum;
      cnt[gy * gw + gx] += 1;
    }
  }
  let maxRho = 0;
  for (let i = 0; i < rho.length; i++) {
    const lum = cnt[i] > 0 ? rho[i] / cnt[i] : 1;
    // 0.01 floor keeps rejection sampling and centroids alive on blank areas.
    rho[i] = Math.pow(Math.max(0.01, invert ? lum : 1 - lum), 1.2);
    if (rho[i] > maxRho) maxRho = rho[i];
  }

  // Seeded rejection sampling of initial sites (grid coordinates).
  const sx = new Float32Array(N), sy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let x = 0, y = 0;
    for (let tries = 0; tries < 64; tries++) {
      x = rand() * gw; y = rand() * gh;
      const r = rho[Math.min(gh - 1, y | 0) * gw + Math.min(gw - 1, x | 0)];
      if (rand() < r / maxRho) break;
    }
    sx[i] = x; sy[i] = y;
  }

  // Lloyd relaxation: JFA nearest-site assignment + ρ-weighted centroid update.
  let ids = new Int32Array(gw * gh);
  let tmp = new Int32Array(gw * gh);
  const wsum = new Float32Array(N), xsum = new Float32Array(N), ysum = new Float32Array(N);

  const dist2 = (cx, cy, i) => {
    const dx = cx - sx[i], dy = cy - sy[i];
    return dx * dx + dy * dy;
  };

  const assign = () => {
    ids.fill(-1);
    for (let i = 0; i < N; i++) {
      const cx = Math.max(0, Math.min(gw - 1, sx[i] | 0));
      const cy = Math.max(0, Math.min(gh - 1, sy[i] | 0));
      const c = cy * gw + cx;
      if (ids[c] === -1 || i < ids[c]) ids[c] = i;
    }
    let step = 1;
    while (step < Math.max(gw, gh)) step <<= 1;
    for (step >>= 1; step >= 1; step >>= 1) {
      for (let y = 0; y < gh; y++) {
        const cy = y + 0.5;
        for (let x = 0; x < gw; x++) {
          const cx = x + 0.5;
          let best = ids[y * gw + x];
          let bd = best >= 0 ? dist2(cx, cy, best) : Infinity;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy * step;
            if (ny < 0 || ny >= gh) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx * step;
              if (nx < 0 || nx >= gw) continue;
              const cand = ids[ny * gw + nx];
              if (cand < 0 || cand === best) continue;
              const d = dist2(cx, cy, cand);
              if (d < bd || (d === bd && cand < best)) { best = cand; bd = d; }
            }
          }
          tmp[y * gw + x] = best;
        }
      }
      const swap = ids; ids = tmp; tmp = swap;
    }
  };

  for (let iter = 0; iter < iters; iter++) {
    assign();
    wsum.fill(0); xsum.fill(0); ysum.fill(0);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const id = ids[y * gw + x];
        if (id < 0) continue;
        const r = rho[y * gw + x];
        wsum[id] += r; xsum[id] += r * (x + 0.5); ysum[id] += r * (y + 0.5);
      }
    }
    for (let i = 0; i < N; i++) {
      if (wsum[i] > 1e-9) {
        sx[i] = xsum[i] / wsum[i]; sy[i] = ysum[i] / wsum[i];
      } else {
        // Region collapsed — re-seed deterministically.
        sx[i] = rand() * gw; sy[i] = rand() * gh;
      }
    }
    onProgress((iter + 1) / (iters + 1));
  }

  // Emit dots: radius follows local density, position scaled to full res.
  for (let i = 0; i < N; i++) {
    const gi = Math.max(0, Math.min(gh - 1, sy[i] | 0)) * gw + Math.max(0, Math.min(gw - 1, sx[i] | 0));
    const t = rho[gi] / maxRho;
    const r = dotMin + (dotMax - dotMin) * t;
    sink.emit({
      dot: true,
      pts: [[sx[i] / scale, sy[i] / scale]],
      radius: r, color: [0, 0, 0], opacity, layer: 0,
      tex: null, dryBrush: 0, height: 0,
    });
  }
  onProgress(1);
}
