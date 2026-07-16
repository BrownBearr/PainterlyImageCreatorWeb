'use strict';

importScripts('brush-texture.js');

// Seeded PRNG — used by the newer algorithms so stroke placement is
// deterministic (important for frame-to-frame stability in video mode).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleArray(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

// ─── Gaussian blur (separable, clamp-to-edge) ─────────────────────────────────

function makeGaussKernel(sigma) {
  const radius = Math.ceil(sigma * 2.5);
  const size = 2 * radius + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-0.5 * x * x / (sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return { k, radius };
}

function gaussianBlurRGB(src, w, h, sigma) {
  const { k, radius } = makeGaussKernel(Math.max(0.1, sigma));
  const tmp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let d = -radius; d <= radius; d++) {
        const xx = Math.max(0, Math.min(w - 1, x + d));
        const w_ = k[d + radius];
        const i = (y * w + xx) * 3;
        r += src[i] * w_; g += src[i + 1] * w_; b += src[i + 2] * w_;
      }
      const i = (y * w + x) * 3;
      tmp[i] = r; tmp[i + 1] = g; tmp[i + 2] = b;
    }
  }

  // Vertical pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let d = -radius; d <= radius; d++) {
        const yy = Math.max(0, Math.min(h - 1, y + d));
        const w_ = k[d + radius];
        const i = (yy * w + x) * 3;
        r += tmp[i] * w_; g += tmp[i + 1] * w_; b += tmp[i + 2] * w_;
      }
      const i = (y * w + x) * 3;
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }
  }
  return out;
}

// ─── Color space ─────────────────────────────────────────────────────────────

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max, v = max;
  if (d > 0) {
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return [h, s, v];
}

function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break; case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break; default: r = v; g = p; b = q;
  }
  return [r * 255, g * 255, b * 255];
}

// ─── Lab (matches OpenCV uint8 Lab encoding) ──────────────────────────────────

function rgbToLab(r, g, b) {
  // sRGB [0..255] -> linear
  r /= 255; g /= 255; b /= 255;
  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

  // Linear RGB -> XYZ D65
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y =  r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;

  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fX = f(X), fY = f(Y), fZ = f(Z);

  // L*a*b* then encode like OpenCV uint8: L*255/100, a+128, b+128
  const L = (116 * fY - 16) * 255 / 100;
  const A = 500 * (fX - fY) + 128;
  const B = 200 * (fY - fZ) + 128;
  return [L, A, B];
}

function buildLabBuffer(rgbF32, w, h) {
  const lab = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const [L, A, B] = rgbToLab(rgbF32[i * 3], rgbF32[i * 3 + 1], rgbF32[i * 3 + 2]);
    lab[i * 3] = L; lab[i * 3 + 1] = A; lab[i * 3 + 2] = B;
  }
  return lab;
}

function computeErrorMap(labRef, labCanvas, w, h) {
  const err = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const dL = labRef[i * 3]     - labCanvas[i * 3];
    const dA = labRef[i * 3 + 1] - labCanvas[i * 3 + 1];
    const dB = labRef[i * 3 + 2] - labCanvas[i * 3 + 2];
    err[i] = Math.sqrt(dL * dL + dA * dA + dB * dB);
  }
  return err;
}

// ─── Sobel gradients ──────────────────────────────────────────────────────────

function computeGradients(rgbF32, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (0.299 * rgbF32[i * 3] + 0.587 * rgbF32[i * 3 + 1] + 0.114 * rgbF32[i * 3 + 2]) / 255;
  }

  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const gmag = new Float32Array(w * h);

  const px = (x, y) => gray[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gxv = -px(x-1,y-1) + px(x+1,y-1) - 2*px(x-1,y) + 2*px(x+1,y) - px(x-1,y+1) + px(x+1,y+1);
      const gyv = -px(x-1,y-1) - 2*px(x,y-1) - px(x+1,y-1) + px(x-1,y+1) + 2*px(x,y+1) + px(x+1,y+1);
      const idx = y * w + x;
      gx[idx] = gxv; gy[idx] = gyv;
      gmag[idx] = Math.sqrt(gxv * gxv + gyv * gyv);
    }
  }
  return { gx, gy, gmag };
}

// ─── Structure-tensor gradient smoothing ──────────────────────────────────────

function computeGradientsST(rgbF32, w, h, sigma) {
  // Raw Sobel first
  const { gx: rawGx, gy: rawGy } = computeGradients(rgbF32, w, h);

  // Build the three tensor components: Jxx = gx^2, Jxy = gx*gy, Jyy = gy^2
  const Jxx = new Float32Array(w * h);
  const Jxy = new Float32Array(w * h);
  const Jyy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    Jxx[i] = rawGx[i] * rawGx[i];
    Jxy[i] = rawGx[i] * rawGy[i];
    Jyy[i] = rawGy[i] * rawGy[i];
  }

  // Gaussian-smooth each component (reuse gaussianBlurRGB by packing into RGB)
  const pack = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { pack[i*3] = Jxx[i]; pack[i*3+1] = Jxy[i]; pack[i*3+2] = Jyy[i]; }
  const smoothed = gaussianBlurRGB(pack, w, h, sigma);

  // Extract smoothed dominant direction (tangent = eigenvector of smaller eigenvalue)
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const gmag = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const sxx = smoothed[i*3], sxy = smoothed[i*3+1], syy = smoothed[i*3+2];
    // Eigenvalues of [[sxx,sxy],[sxy,syy]]
    const tr = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr * 0.25 - det));
    const lam1 = tr * 0.5 + disc; // larger eigenvalue = gradient direction
    // Eigenvector for lam1: [[sxx-lam1, sxy], [sxy, syy-lam1]] * v = 0
    // v = (sxy, lam1 - sxx) or (lam1 - syy, sxy)
    let ex = sxy, ey = lam1 - sxx;
    const em = Math.sqrt(ex * ex + ey * ey);
    if (em > 1e-8) { ex /= em; ey /= em; } else { ex = 1; ey = 0; }
    gx[i] = ex; gy[i] = ey;
    gmag[i] = Math.sqrt(lam1);
  }
  return { gx, gy, gmag };
}

// ─── Automatic salience map ───────────────────────────────────────────────────
// Cheap bottom-up salience (SBR survey §1.3: salience-adaptive stroke density):
// blurred edge energy + local luminance contrast, normalized by the 99th
// percentile, with an optional center-weight prior. Returns Float32Array(w*h)
// in [0,1] where 1 = most salient (deserves the finest strokes).

function computeSalience(srcRGB, w, h, centerWeight) {
  // Salience is low-frequency by construction (its blur σ is ~1/48th of the
  // image), so compute it at reduced resolution (max side ≈ 240) and
  // bilinearly upsample at the end — ~10x cheaper, visually identical map.
  const ds = Math.max(1, Math.ceil(Math.max(w, h) / 240));
  const fullW = w, fullH = h;
  if (ds > 1) {
    const sw = Math.max(8, Math.floor(w / ds)), sh = Math.max(8, Math.floor(h / ds));
    const small = new Float32Array(sw * sh * 3);
    for (let y = 0; y < sh; y++) {
      const sy = Math.min(h - 1, y * ds);
      for (let x = 0; x < sw; x++) {
        const si = (sy * w + Math.min(w - 1, x * ds)) * 3, di = (y * sw + x) * 3;
        small[di] = srcRGB[si]; small[di+1] = srcRGB[si+1]; small[di+2] = srcRGB[si+2];
      }
    }
    srcRGB = small; w = sw; h = sh;
  }

  const { gmag } = computeGradients(srcRGB, w, h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.299 * srcRGB[i*3] + 0.587 * srcRGB[i*3+1] + 0.114 * srcRGB[i*3+2];
  }

  // One blur for both signals via channel packing: R = edge energy (spreads
  // edges into regions), G = luminance (large-scale local average).
  const pack = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { pack[i*3] = gmag[i]; pack[i*3+1] = lum[i]; }
  const blurred = gaussianBlurRGB(pack, w, h, Math.max(2, Math.max(w, h) / 48));

  // Normalize each signal by its 99th percentile (256-bin histogram) so the
  // 0.6/0.4 mix is scale-free and robust to outliers.
  const pct99 = (get) => {
    let max = 1e-6;
    for (let i = 0; i < w * h; i++) if (get(i) > max) max = get(i);
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) hist[Math.min(255, (get(i) / max * 255) | 0)]++;
    let acc = 0, cut = w * h * 0.99;
    for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= cut) return Math.max(1e-6, (b / 255) * max); }
    return max;
  };
  const edgeAt = (i) => blurred[i*3];
  const contrastAt = (i) => Math.abs(lum[i] - blurred[i*3+1]);
  const eN = pct99(edgeAt), cN = pct99(contrastAt);

  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const invR2 = 1 / (cx * cx + cy * cy || 1);
  const sal = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let s = 0.6 * Math.min(1, edgeAt(i) / eN) + 0.4 * Math.min(1, contrastAt(i) / cN);
      if (centerWeight > 0) {
        const d2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) * invR2;
        s *= 1 - centerWeight * d2;
      }
      sal[i] = Math.max(0, Math.min(1, s));
    }
  }
  if (ds === 1) return sal;

  // Bilinear upsample back to full render size.
  const out = new Float32Array(fullW * fullH);
  const fx = (w - 1) / Math.max(1, fullW - 1), fy = (h - 1) / Math.max(1, fullH - 1);
  for (let y = 0; y < fullH; y++) {
    const gy2 = y * fy, y0 = gy2 | 0, y1 = Math.min(h - 1, y0 + 1), ty = gy2 - y0;
    for (let x = 0; x < fullW; x++) {
      const gx2 = x * fx, x0 = gx2 | 0, x1 = Math.min(w - 1, x0 + 1), tx = gx2 - x0;
      const a = sal[y0 * w + x0] * (1 - tx) + sal[y0 * w + x1] * tx;
      const b = sal[y1 * w + x0] * (1 - tx) + sal[y1 * w + x1] * tx;
      out[y * fullW + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// Unified detail map: max(manual mask resampled to render size, salience ×
// strength). Algorithms treat it uniformly — 0 = coarse ok, 1 = full detail.
// Returns null when neither source is active, so the default path costs nothing.
function buildDetailMap(srcRGB, w, h, params) {
  const { maskData = null, maskWidth = 0, maskHeight = 0,
          salienceOn = false, salienceStrength = 0, salienceCenter = 0 } = params;
  const useMask = maskData && maskWidth > 0 && maskHeight > 0;
  const useSal = salienceOn && salienceStrength > 0;
  if (!useMask && !useSal) return null;

  const map = new Float32Array(w * h);
  if (useMask) {
    for (let y = 0; y < h; y++) {
      const my = Math.round(y * (maskHeight - 1) / Math.max(1, h - 1));
      for (let x = 0; x < w; x++) {
        const mx = Math.round(x * (maskWidth - 1) / Math.max(1, w - 1));
        const mi = (my * maskWidth + mx) * 4;
        map[y * w + x] = (maskData[mi] * 0.299 + maskData[mi+1] * 0.587 + maskData[mi+2] * 0.114) / 255;
      }
    }
  }
  if (useSal) {
    const sal = computeSalience(srcRGB, w, h, salienceCenter);
    const s = Math.min(1, salienceStrength);
    for (let i = 0; i < w * h; i++) map[i] = Math.max(map[i], sal[i] * s);
  }
  return map;
}

// ─── Grid cell sampling ───────────────────────────────────────────────────────

function chooseBestInCell(err, x0, y0, x1, y1, w) {
  let bestVal = -1, bestX = x0, bestY = y0, sum = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const e = err[y * w + x];
      sum += e; count++;
      const jittered = e + Math.random() * 1e-3;
      if (jittered > bestVal) { bestVal = jittered; bestX = x; bestY = y; }
    }
  }
  return { sx: bestX, sy: bestY, meanErr: count > 0 ? sum / count : 0 };
}

// ─── Curved stroke path ───────────────────────────────────────────────────────

function makeCurvedStroke(x0, y0, radius, refBlur, canvasRGB, gx, gy, gmag, w, h, params) {
  const { maxLen, minLen, curvature } = params;
  const curv = Math.max(0, Math.min(1, curvature));
  const step = Math.max(1, Math.round(radius));

  x0 = Math.max(0, Math.min(w - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(h - 1, Math.round(y0)));

  const i0 = (y0 * w + x0) * 3;
  const strokeR = refBlur[i0], strokeG = refBlur[i0 + 1], strokeB = refBlur[i0 + 2];

  const pts = [[x0, y0]];
  let lastDx = 0, lastDy = 0;
  let x = x0, y = y0;

  for (let iter = 1; iter <= maxLen; iter++) {
    if (x < 0 || y < 0 || x >= w || y >= h) break;

    if (iter >= minLen) {
      const idx3 = (y * w + x) * 3;
      const dCan = Math.abs(refBlur[idx3] - canvasRGB[idx3])
                 + Math.abs(refBlur[idx3+1] - canvasRGB[idx3+1])
                 + Math.abs(refBlur[idx3+2] - canvasRGB[idx3+2]);
      const dStr = Math.abs(refBlur[idx3] - strokeR)
                 + Math.abs(refBlur[idx3+1] - strokeG)
                 + Math.abs(refBlur[idx3+2] - strokeB);
      if (dCan <= dStr) break;
    }

    const idx = y * w + x;
    if (gmag[idx] * step < 1e-3) break;

    let nx = -gy[idx];
    let ny =  gx[idx];

    if (lastDx * nx + lastDy * ny < 0) { nx = -nx; ny = -ny; }

    nx = curv * nx + (1 - curv) * lastDx;
    ny = curv * ny + (1 - curv) * lastDy;
    const nms = Math.sqrt(nx * nx + ny * ny);
    if (nms < 1e-6) break;
    nx /= nms; ny /= nms;

    x = Math.round(x + step * nx);
    y = Math.round(y + step * ny);
    lastDx = nx; lastDy = ny;

    if (x < 0 || y < 0 || x >= w || y >= h) break;
    pts.push([x, y]);
  }

  return { pts, color: [strokeR, strokeG, strokeB] };
}

// ─── Stroke rendering: solid ──────────────────────────────────────────────────

function drawThickSegment(mask, mw, mh, x0, y0, x1, y1, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(mw - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(mh - 1, Math.ceil(Math.max(y0, y1) + r));

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let dist;
      if (lenSq < 1e-12) {
        const ex = px - x0, ey = py - y0;
        dist = Math.sqrt(ex * ex + ey * ey);
      } else {
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
        const cx = x0 + t * dx, cy = y0 + t * dy;
        const ex = px - cx, ey = py - cy;
        dist = Math.sqrt(ex * ex + ey * ey);
      }
      const v = Math.max(0, Math.min(1, r - dist + 0.5));
      if (v > mask[py * mw + px]) mask[py * mw + px] = v;
    }
  }
}

// Textured variant: same capsule coverage, but modulated by a brush tile
// sampled in stroke-local (u, v) space, with a taper LUT shrinking the
// effective radius near the stroke ends. arc0/segLen/totalLen give this
// segment's arc-length span so u is continuous across segment joins.
function drawThickSegmentTextured(mask, mw, mh, x0, y0, x1, y1, r, tex, arc0, segLen, totalLen) {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  const len = Math.sqrt(lenSq);
  const { tile, tw, th, uOff, strength, taperLUT, uScale } = tex;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(mw - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(mh - 1, Math.ceil(Math.max(y0, y1) + r));

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let t, dist, perp;
      if (lenSq < 1e-12) {
        const ex = px - x0, ey = py - y0;
        t = 0;
        dist = Math.sqrt(ex * ex + ey * ey);
        perp = dist; // degenerate (round dab): orientation is meaningless
      } else {
        t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
        const cx = x0 + t * dx, cy = y0 + t * dy;
        const ex = px - cx, ey = py - cy;
        dist = Math.sqrt(ex * ex + ey * ey);
        perp = ((px - x0) * dy - (py - y0) * dx) / len;
      }
      const arc = arc0 + t * segLen;
      const ui = Math.min(BRUSH_TEX_W - 1, Math.max(0, ((arc / totalLen) * (BRUSH_TEX_W - 1)) | 0));
      const rEff = r * taperLUT[ui];
      const cov = Math.max(0, Math.min(1, rEff - dist + 0.5));
      if (cov <= 0) continue;
      const vNorm = Math.max(-1, Math.min(1, perp / Math.max(0.5, rEff)));
      let tx = ((arc * uScale + uOff) % tw) | 0;
      if (tx < 0) tx += tw;
      const ty = ((vNorm * 0.5 + 0.5) * (th - 1) + 0.5) | 0;
      const v = cov * (1 - strength + strength * tile[ty * tw + tx]);
      if (v > mask[py * mw + px]) mask[py * mw + px] = v;
    }
  }
}

function drawCircle(mask, mw, mh, cx, cy, r, vScale = 1) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(mw - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(mh - 1, Math.ceil(cy + r + 1));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const ex = px - cx, ey = py - cy;
      const v = Math.max(0, Math.min(1, r - Math.sqrt(ex * ex + ey * ey) + 0.5)) * vScale;
      if (v > mask[py * mw + px]) mask[py * mw + px] = v;
    }
  }
}

function renderStrokeSolid(canvasRGB, pts, radius, color, opacity, w, h, heightBuf, impastoStrength, dryBrushAmount, tex = null) {
  if (pts.length < 2) return;
  const [sr, sg, sb] = color;
  const nSegs = pts.length - 1;

  // Textured strokes need cumulative arc lengths so the tile's u coordinate is
  // continuous across segment joins. Tile repeats every ~4 radii of arc.
  let arcLens = null, totalLen = 1, capR0 = radius, capR1 = radius, capScale = 1;
  if (tex && tex.strength > 0) {
    arcLens = new Float32Array(nSegs + 1);
    for (let i = 0; i < nSegs; i++) {
      const ddx = pts[i + 1][0] - pts[i][0], ddy = pts[i + 1][1] - pts[i][1];
      arcLens[i + 1] = arcLens[i] + Math.sqrt(ddx * ddx + ddy * ddy);
    }
    totalLen = Math.max(1e-6, arcLens[nSegs]);
    tex.uScale = tex.tw / Math.max(16, radius * 4);
    capR0 = radius * tex.taperLUT[0];
    capR1 = radius * tex.taperLUT[tex.taperLUT.length - 1];
    capScale = 1 - tex.strength * 0.35; // approximate mean tile coverage
  } else {
    tex = null;
  }

  // When dry-brush is active, composite each segment separately with a fading opacity.
  // Otherwise build a single unified mask (original behaviour, cheaper).
  if (dryBrushAmount > 0) {
    for (let seg = 0; seg < nSegs; seg++) {
      const t = nSegs > 1 ? seg / (nSegs - 1) : 0;
      const segOpacity = Math.max(0, opacity * (1 - dryBrushAmount * t));
      if (segOpacity <= 0) continue;

      const segPts = [pts[seg], pts[seg + 1]];
      const sx0 = segPts[0][0], sy0 = segPts[0][1];
      const sx1 = segPts[1][0], sy1 = segPts[1][1];
      const pad = Math.ceil(radius) + 2;
      // floor/ceil: stroke points may be fractional; the mask box must be integral
      const bx0 = Math.max(0, Math.floor(Math.min(sx0, sx1) - pad));
      const by0 = Math.max(0, Math.floor(Math.min(sy0, sy1) - pad));
      const bx1 = Math.min(w, Math.ceil(Math.max(sx0, sx1) + pad + 1));
      const by1 = Math.min(h, Math.ceil(Math.max(sy0, sy1) + pad + 1));
      if (bx1 <= bx0 || by1 <= by0) continue;
      const mw = bx1 - bx0, mh = by1 - by0;
      const mask = new Float32Array(mw * mh);
      if (tex) {
        drawThickSegmentTextured(mask, mw, mh, sx0-bx0, sy0-by0, sx1-bx0, sy1-by0, radius,
                                 tex, arcLens[seg], arcLens[seg+1] - arcLens[seg], totalLen);
        if (seg === 0)        drawCircle(mask, mw, mh, sx0-bx0, sy0-by0, capR0, capScale);
        if (seg === nSegs-1)  drawCircle(mask, mw, mh, sx1-bx0, sy1-by0, capR1, capScale);
      } else {
        drawThickSegment(mask, mw, mh, sx0-bx0, sy0-by0, sx1-bx0, sy1-by0, radius);
        if (seg === 0)        drawCircle(mask, mw, mh, sx0-bx0, sy0-by0, radius);
        if (seg === nSegs-1)  drawCircle(mask, mw, mh, sx1-bx0, sy1-by0, radius);
      }
      for (let my = 0; my < mh; my++) {
        for (let mx = 0; mx < mw; mx++) {
          const mv = mask[my * mw + mx];
          const a = Math.min(1, mv * segOpacity);
          if (a <= 0) continue;
          const ci = ((by0 + my) * w + (bx0 + mx)) * 3;
          canvasRGB[ci]     = canvasRGB[ci]     * (1 - a) + sr * a;
          canvasRGB[ci + 1] = canvasRGB[ci + 1] * (1 - a) + sg * a;
          canvasRGB[ci + 2] = canvasRGB[ci + 2] * (1 - a) + sb * a;
          if (heightBuf && impastoStrength > 0) heightBuf[(by0+my)*w+(bx0+mx)] += mv * impastoStrength;
        }
      }
    }
    return;
  }

  // Standard path: single unified mask
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of pts) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const pad = Math.ceil(radius) + 2;
  // floor/ceil: stroke points may be fractional; the mask box must be integral
  const bx0 = Math.max(0, Math.floor(minX - pad)), by0 = Math.max(0, Math.floor(minY - pad));
  const bx1 = Math.min(w, Math.ceil(maxX + pad + 1)), by1 = Math.min(h, Math.ceil(maxY + pad + 1));
  if (bx1 <= bx0 || by1 <= by0) return;

  const mw = bx1 - bx0, mh = by1 - by0;
  const mask = new Float32Array(mw * mh);

  if (tex) {
    for (let seg = 0; seg < nSegs; seg++) {
      drawThickSegmentTextured(mask, mw, mh, pts[seg][0]-bx0, pts[seg][1]-by0, pts[seg+1][0]-bx0, pts[seg+1][1]-by0, radius,
                               tex, arcLens[seg], arcLens[seg+1] - arcLens[seg], totalLen);
    }
    drawCircle(mask, mw, mh, pts[0][0]-bx0, pts[0][1]-by0, capR0, capScale);
    drawCircle(mask, mw, mh, pts[pts.length-1][0]-bx0, pts[pts.length-1][1]-by0, capR1, capScale);
  } else {
    for (let seg = 0; seg < nSegs; seg++) {
      drawThickSegment(mask, mw, mh, pts[seg][0]-bx0, pts[seg][1]-by0, pts[seg+1][0]-bx0, pts[seg+1][1]-by0, radius);
    }
    drawCircle(mask, mw, mh, pts[0][0]-bx0, pts[0][1]-by0, radius);
    drawCircle(mask, mw, mh, pts[pts.length-1][0]-bx0, pts[pts.length-1][1]-by0, radius);
  }

  for (let my = 0; my < mh; my++) {
    for (let mx = 0; mx < mw; mx++) {
      const mv = mask[my * mw + mx];
      const a = Math.min(1, mv * opacity);
      if (a <= 0) continue;
      const ci = ((by0 + my) * w + (bx0 + mx)) * 3;
      canvasRGB[ci]     = canvasRGB[ci]     * (1 - a) + sr * a;
      canvasRGB[ci + 1] = canvasRGB[ci + 1] * (1 - a) + sg * a;
      canvasRGB[ci + 2] = canvasRGB[ci + 2] * (1 - a) + sb * a;
      if (heightBuf && impastoStrength > 0) {
        heightBuf[(by0 + my) * w + (bx0 + mx)] += mv * impastoStrength;
      }
    }
  }
}

// ─── Palette quantization (k-means, fixed 20 iterations) ─────────────────────

function buildPalette(srcRGB, w, h, k) {
  if (k <= 0) return null;
  k = Math.min(k, 32);

  // Sample up to 2000 pixels for speed
  const stride = Math.max(1, Math.floor(w * h / 2000));
  const samples = [];
  for (let i = 0; i < w * h; i += stride) {
    samples.push([srcRGB[i*3], srcRGB[i*3+1], srcRGB[i*3+2]]);
  }

  // Initialise centroids by spreading through samples
  const centroids = [];
  const step = Math.max(1, Math.floor(samples.length / k));
  for (let i = 0; i < k; i++) centroids.push([...samples[Math.min(i * step, samples.length - 1)]]);

  for (let iter = 0; iter < 20; iter++) {
    const sums = Array.from({length: k}, () => [0, 0, 0, 0]); // r,g,b,count
    for (const [r, g, b] of samples) {
      let best = 0, bestD = Infinity;
      for (let ci = 0; ci < k; ci++) {
        const dr = r - centroids[ci][0], dg = g - centroids[ci][1], db = b - centroids[ci][2];
        const d = dr*dr + dg*dg + db*db;
        if (d < bestD) { bestD = d; best = ci; }
      }
      sums[best][0] += r; sums[best][1] += g; sums[best][2] += b; sums[best][3]++;
    }
    for (let ci = 0; ci < k; ci++) {
      if (sums[ci][3] > 0) {
        centroids[ci][0] = sums[ci][0] / sums[ci][3];
        centroids[ci][1] = sums[ci][1] / sums[ci][3];
        centroids[ci][2] = sums[ci][2] / sums[ci][3];
      }
    }
  }
  return centroids;
}

function snapToPalette(r, g, b, palette) {
  let best = 0, bestD = Infinity;
  for (let ci = 0; ci < palette.length; ci++) {
    const dr = r - palette[ci][0], dg = g - palette[ci][1], db = b - palette[ci][2];
    const d = dr*dr + dg*dg + db*db;
    if (d < bestD) { bestD = d; best = ci; }
  }
  return palette[best];
}

// ─── Downscale / upscale helpers ──────────────────────────────────────────────

function downscaleRGBA(srcData, sw, sh, dw, dh) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const scaleX = sw / dw, scaleY = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, Math.floor(dx * scaleX));
      const sy = Math.min(sh - 1, Math.floor(dy * scaleY));
      const si = (sy * sw + sx) * 4, di = (dy * dw + dx) * 4;
      dst[di] = srcData[si]; dst[di+1] = srcData[si+1];
      dst[di+2] = srcData[si+2]; dst[di+3] = srcData[si+3];
    }
  }
  return dst;
}

function upscaleRGB(srcRGB, sw, sh, dw, dh) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const scaleX = sw / dw, scaleY = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, Math.floor(dx * scaleX));
      const sy = Math.min(sh - 1, Math.floor(dy * scaleY));
      const si = (sy * sw + sx) * 3, di = (dy * dw + dx) * 4;
      dst[di] = Math.round(srcRGB[si]);
      dst[di+1] = Math.round(srcRGB[si+1]);
      dst[di+2] = Math.round(srcRGB[si+2]);
      dst[di+3] = 255;
    }
  }
  return dst;
}

// ─── Shared algorithm helpers ─────────────────────────────────────────────────

// Palette snap then HSV jitter — the common per-stroke color pipeline.
function finalizeStrokeColor(r, g, b, params, palette, rand = Math.random) {
  let color = palette ? snapToPalette(r, g, b, palette) : [r, g, b];
  const { hueJitter = 0, satJitter = 0, valJitter = 0 } = params;
  if (hueJitter > 0 || satJitter > 0 || valJitter > 0) {
    let [h2, s2, v2] = rgbToHsv(color[0], color[1], color[2]);
    h2 += (rand() * 2 - 1) * hueJitter;
    s2 = Math.max(0, Math.min(1, s2 + (rand() * 2 - 1) * satJitter));
    v2 = Math.max(0, Math.min(1, v2 + (rand() * 2 - 1) * valJitter));
    color = hsvToRgb(h2, s2, v2);
  }
  return color;
}

// Fill the starting canvas per underpaintMode ('blur' | 'none' | 'average').
function applyUnderpaint(env) {
  const { srcRGB, canvasRGB, w, h, radii, params } = env;
  const mode = params.underpaintMode ?? 'blur';
  if (mode === 'blur') {
    // Blur the source at the coarsest radius and use that as the starting canvas
    const blurSigma = Math.max(0.1, (radii[0] ?? 8) * 0.5);
    canvasRGB.set(gaussianBlurRGB(srcRGB, w, h, blurSigma));
  } else if (mode === 'none') {
    canvasRGB.fill(255);
  } else {
    // 'average': fill with mean color of the image
    let sumR = 0, sumG = 0, sumB = 0;
    for (let i = 0; i < w * h; i++) {
      sumR += srcRGB[i * 3]; sumG += srcRGB[i * 3 + 1]; sumB += srcRGB[i * 3 + 2];
    }
    const n = w * h;
    for (let i = 0; i < w * h; i++) {
      canvasRGB[i * 3] = sumR / n; canvasRGB[i * 3 + 1] = sumG / n; canvasRGB[i * 3 + 2] = sumB / n;
    }
  }
}

// Impasto height-map lighting pass (Hertzmann 2002 "Fast Paint Texture").
function applyImpastoLighting(env) {
  const { canvasRGB, heightBuf, w, h, params } = env;
  const { lightAngle = 45, impastoLightStrength = 0 } = params;
  if (!heightBuf || impastoLightStrength <= 0) return;

  const ambient = 0.6;
  const angleRad = (lightAngle * Math.PI) / 180;
  const lx = Math.cos(angleRad), ly = -Math.sin(angleRad), lz = 0.5;
  const llen = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const nlx = lx / llen, nly = ly / llen, nlz = lz / llen;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const get = (xx, yy) => heightBuf[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))];
      const dzdx = (get(x + 1, y) - get(x - 1, y)) * 0.5;
      const dzdy = (get(x, y + 1) - get(x, y - 1)) * 0.5;
      // Surface normal: (-dzdx, -dzdy, 1) normalized
      const nx = -dzdx, ny = -dzdy, nz = 1.0;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dot = Math.max(0, (nx / nlen) * nlx + (ny / nlen) * nly + (nz / nlen) * nlz);
      const light = ambient + impastoLightStrength * dot;
      const ci = (y * w + x) * 3;
      canvasRGB[ci]     = Math.min(255, canvasRGB[ci]     * light);
      canvasRGB[ci + 1] = Math.min(255, canvasRGB[ci + 1] * light);
      canvasRGB[ci + 2] = Math.min(255, canvasRGB[ci + 2] * light);
    }
  }
}

// ─── Algorithm: Hertzmann 1998 — curved brush strokes of multiple sizes ───────

function paintHertzmann(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, heightBuf, onProgress, prevState, brushTex, detailMap } = env;
  const { threshold, maxStrokeLength, minStrokeLength, curvature, opacity, gridFactor,
          frameDiffThreshold = 0,
          impastoStrength = 0, dryBrushAmount = 0, tensorSigma = 0 } = params;

  // Temporal coherence: when prevState is provided, seed canvas from previous frame
  // and build a per-pixel diff mask to skip unchanged cells.
  let cellDiffMap = null; // Float32Array(w * h) — max pixel diff per cell, built per layer
  const useTemporal = prevState && frameDiffThreshold > 0
    && prevState.prevCanvasRGB && prevState.prevSrcRGB
    && prevState.prevCanvasRGB.length === w * h * 3
    && prevState.prevSrcRGB.length === w * h * 3;

  if (useTemporal) {
    canvasRGB.set(prevState.prevCanvasRGB);
    cellDiffMap = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const dr = Math.abs(srcRGB[i*3]   - prevState.prevSrcRGB[i*3]);
      const dg = Math.abs(srcRGB[i*3+1] - prevState.prevSrcRGB[i*3+1]);
      const db = Math.abs(srcRGB[i*3+2] - prevState.prevSrcRGB[i*3+2]);
      cellDiffMap[i] = (dr + dg + db) / 3;
    }
  } else {
    applyUnderpaint(env);
  }

  for (let ri = 0; ri < radii.length; ri++) {
    const radius = Math.max(1, Math.round(radii[ri]));
    const sigma = Math.max(0.1, radius * 0.5);

    const refBlur = gaussianBlurRGB(srcRGB, w, h, sigma);
    const labRef = buildLabBuffer(refBlur, w, h);
    const { gx, gy, gmag } = tensorSigma > 0
      ? computeGradientsST(refBlur, w, h, tensorSigma)
      : computeGradients(refBlur, w, h);
    const labCanvas = buildLabBuffer(canvasRGB, w, h);
    const err = computeErrorMap(labRef, labCanvas, w, h);

    const grid = Math.max(1, Math.round(radius * gridFactor));
    const cells = [];
    for (let y0 = 0; y0 < h; y0 += grid) {
      for (let x0 = 0; x0 < w; x0 += grid) {
        cells.push([x0, y0]);
      }
    }
    shuffleArray(cells);

    const isFirstLayer = ri === 0;

    for (const [cx0, cy0] of cells) {
      const cx1 = Math.min(w, cx0 + grid), cy1 = Math.min(h, cy0 + grid);
      const { sx, sy, meanErr } = chooseBestInCell(err, cx0, cy0, cx1, cy1, w);

      // Detail map (mask ∪ salience): lower the threshold where detail is wanted
      const effectiveThreshold = detailMap
        ? Math.max(1, threshold * (1 - detailMap[sy * w + sx]))
        : threshold;
      if (meanErr <= effectiveThreshold && !isFirstLayer) continue;

      // Temporal coherence: skip cell if max source diff is below threshold
      if (cellDiffMap) {
        let maxDiff = 0;
        for (let cy = cy0; cy < cy1; cy++)
          for (let cx = cx0; cx < cx1; cx++)
            if (cellDiffMap[cy * w + cx] > maxDiff) maxDiff = cellDiffMap[cy * w + cx];
        if (maxDiff < frameDiffThreshold) continue;
      }

      const { pts, color } = makeCurvedStroke(
        sx, sy, radius, refBlur, canvasRGB, gx, gy, gmag, w, h,
        { maxLen: maxStrokeLength, minLen: minStrokeLength, curvature }
      );

      const strokeColor = finalizeStrokeColor(color[0], color[1], color[2], params, palette);

      renderStrokeSolid(canvasRGB, pts, radius, strokeColor, opacity, w, h, heightBuf, impastoStrength, dryBrushAmount,
                        getStrokeTexture(brushTex, ri, sx, sy));
    }

    onProgress((ri + 1) / radii.length);
  }
}

// ─── Algorithm: Litwinowicz 1997 — impressionist oriented strokes ─────────────
// "Processing Images and Video for an Impressionist Effect": short oriented
// rectangular strokes on a jittered grid, direction perpendicular to the
// (smoothed) image gradient, clipped where they would cross a strong edge.

function paintLitwinowicz(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, heightBuf, onProgress, brushTex, detailMap } = env;
  const { maxStrokeLength, minStrokeLength, gridFactor, opacity,
          impastoStrength = 0, dryBrushAmount = 0, tensorSigma = 0 } = params;
  const rand = mulberry32(0xC0FFEE);

  applyUnderpaint(env);

  // Single stroke width: the first (coarsest) brush radius.
  const radius = Math.max(1, Math.round(radii[0] ?? 3));
  const refBlur = gaussianBlurRGB(srcRGB, w, h, Math.max(0.5, radius * 0.5));

  // Smoothed orientation field (the paper smooths/interpolates directions);
  // the Direction smoothing slider overrides the default σ when set.
  const { gx, gy, gmag } = computeGradientsST(refBlur, w, h, tensorSigma > 0 ? tensorSigma : 2.0);

  // Raw Sobel magnitude for edge clipping.
  const { gmag: edgeMag } = computeGradients(refBlur, w, h);
  let maxEdge = 0;
  for (let i = 0; i < edgeMag.length; i++) if (edgeMag[i] > maxEdge) maxEdge = edgeMag[i];
  const edgeThresh = 0.35 * maxEdge;

  // Jittered grid of stroke centers.
  const spacing = Math.max(1, Math.round(radius * 2 * gridFactor));
  const centers = [];
  for (let y = 0; y < h; y += spacing) {
    for (let x = 0; x < w; x += spacing) {
      const jx = Math.max(0, Math.min(w - 1, Math.round(x + (rand() - 0.5) * spacing)));
      const jy = Math.max(0, Math.min(h - 1, Math.round(y + (rand() - 0.5) * spacing)));
      centers.push([jx, jy]);
      // Detail coupling: salient cells get 1–2 extra jittered strokes.
      if (detailMap) {
        const extra = Math.round(2 * detailMap[jy * w + jx]);
        for (let k = 0; k < extra; k++) {
          centers.push([
            Math.max(0, Math.min(w - 1, Math.round(x + (rand() - 0.5) * spacing))),
            Math.max(0, Math.min(h - 1, Math.round(y + (rand() - 0.5) * spacing))),
          ]);
        }
      }
    }
  }
  shuffleArray(centers, rand);

  const total = centers.length;
  let done = 0;
  for (const [cx, cy] of centers) {
    const idx = cy * w + cx;

    // Stroke direction: perpendicular to the gradient; constant 45° where
    // the gradient is too weak to be meaningful (paper's fallback).
    let theta = gmag[idx] > 1e-4 ? Math.atan2(gx[idx], -gy[idx]) : Math.PI / 4;
    theta += (rand() * 2 - 1) * 0.26; // ±15° perturbation
    const dx = Math.cos(theta), dy = Math.sin(theta);

    // Length from the sliders with a ±15% perturbation.
    const targetLen = (minStrokeLength + rand() * Math.max(0, maxStrokeLength - minStrokeLength))
                    * (0.85 + rand() * 0.3);
    const half = Math.max(0.5, targetLen / 2);

    // March out from the center in both directions, stopping at strong edges
    // so strokes never bleed across object boundaries.
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

    const color = finalizeStrokeColor(
      refBlur[idx * 3], refBlur[idx * 3 + 1], refBlur[idx * 3 + 2], params, palette, rand);
    // Detail coupling: thinner strokes where the detail map is bright.
    const rStroke = detailMap
      ? Math.max(1, Math.round(radius * (1 - 0.35 * detailMap[idx])))
      : radius;
    renderStrokeSolid(canvasRGB, [p0, p1], rStroke, color, opacity, w, h,
                      heightBuf, impastoStrength, dryBrushAmount,
                      getStrokeTexture(brushTex, 0, cx, cy));

    if ((++done & 2047) === 0) onProgress(done / total);
  }
  onProgress(1);
}

// ─── Algorithm: Haeberli 1990 — paint by numbers ──────────────────────────────
// Random point-sampled dabs, one pass per brush radius coarse → fine, color
// sampled from the source at each dab position.

function paintHaeberli(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, heightBuf, onProgress, brushTex, detailMap } = env;
  const { maxStrokeLength, gridFactor, opacity, impastoStrength = 0 } = params;
  const rand = mulberry32(0xBADA55);

  applyUnderpaint(env);

  for (let ri = 0; ri < radii.length; ri++) {
    const r = Math.max(1, Math.round(radii[ri]));
    const refBlur = gaussianBlurRGB(srcRGB, w, h, Math.max(0.5, r * 0.4));
    const { gx, gy, gmag } = computeGradients(refBlur, w, h);

    // Enough dabs to statistically cover the image at this scale.
    const cell = Math.max(1, r * gridFactor);
    const nDabs = Math.ceil((w * h) / (cell * cell));

    for (let i = 0; i < nDabs; i++) {
      const x = Math.floor(rand() * w), y = Math.floor(rand() * h);
      const idx = y * w + x;
      const color = finalizeStrokeColor(
        refBlur[idx * 3], refBlur[idx * 3 + 1], refBlur[idx * 3 + 2], params, palette, rand);

      // Round dab by default (degenerate segment renders as a circle);
      // elongated gradient-oriented daub when the stroke length allows it
      // and the local gradient is meaningful.
      let p0 = [x, y], p1 = [x, y];
      if (maxStrokeLength > 2 && gmag[idx] > 1e-4) {
        const len = Math.min(maxStrokeLength, r * 2);
        const dx = -gy[idx] / gmag[idx], dy = gx[idx] / gmag[idx];
        p0 = [x - dx * len / 2, y - dy * len / 2];
        p1 = [x + dx * len / 2, y + dy * len / 2];
      }
      // Detail coupling: smaller dabs where the detail map is bright, plus a
      // probabilistic extra dab so salient areas end up denser.
      const d = detailMap ? detailMap[idx] : 0;
      const rDab = d > 0 ? Math.max(1, Math.round(r * (1 - 0.35 * d))) : r;
      renderStrokeSolid(canvasRGB, [p0, p1], rDab, color, opacity, w, h,
                        heightBuf, impastoStrength, 0,
                        getStrokeTexture(brushTex, ri, x, y));
      if (d > 0 && rand() < 0.6 * d) {
        const x2 = Math.max(0, Math.min(w - 1, Math.round(x + (rand() - 0.5) * r * 2)));
        const y2 = Math.max(0, Math.min(h - 1, Math.round(y + (rand() - 0.5) * r * 2)));
        const i2 = y2 * w + x2;
        const c2 = finalizeStrokeColor(
          refBlur[i2 * 3], refBlur[i2 * 3 + 1], refBlur[i2 * 3 + 2], params, palette, rand);
        renderStrokeSolid(canvasRGB, [[x2, y2], [x2, y2]], Math.max(1, Math.round(rDab * 0.8)),
                          c2, opacity, w, h, heightBuf, impastoStrength, 0,
                          getStrokeTexture(brushTex, ri, x2, y2));
      }

      if ((i & 4095) === 0) onProgress((ri + i / nDabs) / radii.length);
    }
    onProgress((ri + 1) / radii.length);
  }
}

// ─── Algorithm: colored pencil sketch ─────────────────────────────────────────
// Stroke-based hatching (not a filter): white paper, directional colored hatch
// strokes that skip highlights, cross-hatching in shadows, edge-emphasis
// strokes along strong contours, and a deterministic paper-grain pass.

function paintPencil(env) {
  const { srcRGB, canvasRGB, w, h, radii, params, palette, onProgress, brushTex } = env;
  const { maxStrokeLength, minStrokeLength, gridFactor, opacity, tensorSigma = 0 } = params;
  const rand = mulberry32(0x9E3779B9);

  // Pencil always draws on near-white paper, regardless of underpaintMode.
  canvasRGB.fill(252);

  const refBlur = gaussianBlurRGB(srcRGB, w, h, 1.0);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.299 * refBlur[i*3] + 0.587 * refBlur[i*3+1] + 0.114 * refBlur[i*3+2]) / 255;
  }

  // Smoothed direction field for coherent hatching; raw Sobel for edges.
  const { gx, gy, gmag } = computeGradientsST(refBlur, w, h, Math.max(2, tensorSigma));
  const edges = computeGradients(refBlur, w, h);
  let maxEdge = 0;
  for (let i = 0; i < edges.gmag.length; i++) if (edges.gmag[i] > maxEdge) maxEdge = edges.gmag[i];
  const edgeThresh = 0.30 * maxEdge;

  const globalHatch = Math.PI / 4; // fallback hatch angle in flat regions

  // Pencil pigment: source color, slightly more saturated and darker.
  const pencilColor = (idx, darken = 0.82) => {
    let [hh, ss, vv] = rgbToHsv(refBlur[idx*3], refBlur[idx*3+1], refBlur[idx*3+2]);
    ss = Math.min(1, ss * 1.3 + 0.05);
    vv = vv * darken;
    const [r2, g2, b2] = hsvToRgb(hh, ss, vv);
    return finalizeStrokeColor(r2, g2, b2, params, palette, rand);
  };

  // One hatch stroke: 3-point polyline with a slight midpoint wobble so
  // strokes read as hand-drawn rather than ruled.
  const hatchStroke = (cx, cy, theta, len, r, color, op, tex = null) => {
    const dx = Math.cos(theta), dy = Math.sin(theta);
    const half = len / 2;
    const wob = (rand() - 0.5) * r * 1.2;
    const p0 = [cx - dx * half, cy - dy * half];
    const pm = [cx - dy * wob, cy + dx * wob];
    const p1 = [cx + dx * half, cy + dy * half];
    renderStrokeSolid(canvasRGB, [p0, pm, p1], r, color, op, w, h, null, 0, 0, tex);
  };

  // Passes A/B: hatching (+ cross-hatching in dark regions) per pencil radius.
  const nPasses = radii.length;
  for (let ri = 0; ri < nPasses; ri++) {
    const r = Math.max(0.7, radii[ri] * 0.7); // pencil tips are thin
    const spacing = Math.max(2, Math.round(radii[ri] * 2 * gridFactor));
    for (let y = 0; y < h; y += spacing) {
      for (let x = 0; x < w; x += spacing) {
        const jx = Math.max(0, Math.min(w - 1, Math.round(x + (rand() - 0.5) * spacing)));
        const jy = Math.max(0, Math.min(h - 1, Math.round(y + (rand() - 0.5) * spacing)));
        const idx = jy * w + jx;
        const d = 1 - lum[idx]; // darkness 0..1

        // Light areas stay mostly paper.
        if (rand() > d * 1.35 + 0.06) continue;

        let theta = gmag[idx] > 1e-4 ? Math.atan2(gx[idx], -gy[idx]) : globalHatch;
        theta += (rand() - 0.5) * 0.2;
        const len = minStrokeLength + rand() * Math.max(0, maxStrokeLength - minStrokeLength);
        const color = pencilColor(idx);
        const op = opacity * (0.45 + 0.55 * d);

        const tex = getStrokeTexture(brushTex, ri, jx, jy);
        hatchStroke(jx, jy, theta, len, r, color, op, tex);
        // Cross-hatch shadows at ~+80°.
        if (d > 0.55) hatchStroke(jx, jy, theta + 1.4, len * 0.8, r, color, op * 0.8, tex);
      }
    }
    onProgress((ri + 1) / (nPasses + 1));
  }

  // Pass C: edge emphasis — thin short strokes along edge tangents.
  const rEdge = Math.max(0.7, (radii[radii.length - 1] ?? 1) * 0.5);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const idx = y * w + x;
      if (edges.gmag[idx] <= edgeThresh) continue;
      if (rand() > 0.6) continue; // thin out for a sketchy, broken line
      const theta = Math.atan2(edges.gx[idx], -edges.gy[idx]); // ⊥ gradient = along edge
      const len = 3 + rand() * 4;
      const color = pencilColor(idx, 0.6); // darker pigment on contours
      hatchStroke(x, y, theta, len, rEdge, color, Math.min(1, opacity * 1.4),
                  getStrokeTexture(brushTex, radii.length - 1, x, y));
    }
  }

  // Pass D: deterministic paper grain (multiplicative hash noise) — stable
  // across video frames because it depends only on pixel coordinates.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const g = 1 - 0.05 * (n - Math.floor(n));
      const ci = (y * w + x) * 3;
      canvasRGB[ci] *= g; canvasRGB[ci + 1] *= g; canvasRGB[ci + 2] *= g;
    }
  }
  onProgress(1);
}

// ─── Algorithm registry ───────────────────────────────────────────────────────

const ALGORITHMS = {
  hertzmann:   paintHertzmann,   // Hertzmann 1998 — curved brush strokes
  litwinowicz: paintLitwinowicz, // Litwinowicz 1997 — impressionist strokes
  haeberli:    paintHaeberli,    // Haeberli 1990 — paint by numbers
  pencil:      paintPencil,      // colored pencil sketch (hatching)
  // 'neural' (Paint Transformer 2021) is registered lazily by ensureNeural()
  // so classic modes never load onnxruntime.
};

function ensureNeural() {
  if (!ALGORITHMS.neural) {
    importScripts('vendor/ort/ort.min.js', 'neural.js');
    ALGORITHMS.neural = paintNeural;
  }
}

// ─── Main paintify driver ─────────────────────────────────────────────────────

async function paintify(imageData, params, onProgress, prevState, onStatus) {
  let { width: origW, height: origH } = imageData;
  let srcData = imageData.data;

  // Fast preview: downscale before processing
  let procW = origW, procH = origH;
  if (params.fastPreview) {
    const maxSide = 400;
    const scale = Math.min(1, maxSide / Math.max(origW, origH));
    if (scale < 1) {
      procW = Math.max(1, Math.round(origW * scale));
      procH = Math.max(1, Math.round(origH * scale));
      srcData = downscaleRGBA(srcData, origW, origH, procW, procH);
    }
  }

  const w = procW, h = procH;

  // RGBA -> RGB float
  const srcRGB = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    srcRGB[i * 3]     = srcData[i * 4];
    srcRGB[i * 3 + 1] = srcData[i * 4 + 1];
    srcRGB[i * 3 + 2] = srcData[i * 4 + 2];
  }

  const { brushRadii, impastoStrength = 0, impastoLightStrength = 0,
          frameDiffThreshold = 0, paletteSize = 0 } = params;

  const radii = [...brushRadii].map(Number).filter(r => r >= 1).sort((a, b) => b - a);
  if (radii.length === 0) radii.push(4);

  const canvasRGB = new Float32Array(w * h * 3);
  const heightBuf = (impastoStrength > 0 || impastoLightStrength > 0)
    ? new Float32Array(w * h) : null;
  const palette = paletteSize > 1 ? buildPalette(srcRGB, w, h, paletteSize) : null;

  const paint = ALGORITHMS[params.algorithm] || paintHertzmann;
  const isHertzmann = paint === paintHertzmann;

  // Brush texture tiles: only built when the effect is on, so strength 0 keeps
  // the legacy code path with zero overhead.
  const brushTex = (params.brushTexture > 0) ? makeBrushTextures(radii, params) : null;

  // Unified detail map (manual mask ∪ salience); null when both are off.
  const detailMap = buildDetailMap(srcRGB, w, h, params);

  const env = {
    srcRGB, canvasRGB, w, h, radii, params, palette, heightBuf, onProgress, brushTex, detailMap,
    onStatus: onStatus || null,
    // Temporal coherence is error-map driven and only supported by Hertzmann.
    prevState: isHertzmann ? (prevState || null) : null,
  };

  if (params.salienceDebug) {
    // Debug view: output the detail map itself as grayscale instead of painting.
    for (let i = 0; i < w * h; i++) {
      const v = detailMap ? detailMap[i] * 255 : 0;
      canvasRGB[i*3] = v; canvasRGB[i*3+1] = v; canvasRGB[i*3+2] = v;
    }
    onProgress(1);
  } else {
    await paint(env); // classic algorithms are sync; neural returns a promise
    applyImpastoLighting(env);
  }

  // Return final ImageData (upscale if fast preview)
  let resultData;
  if (params.fastPreview && (procW !== origW || procH !== origH)) {
    resultData = upscaleRGB(canvasRGB, procW, procH, origW, origH);
  } else {
    resultData = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      resultData[i * 4]     = Math.max(0, Math.min(255, Math.round(canvasRGB[i * 3])));
      resultData[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(canvasRGB[i * 3 + 1])));
      resultData[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(canvasRGB[i * 3 + 2])));
      resultData[i * 4 + 3] = 255;
    }
  }

  const out = { data: resultData, width: origW, height: origH };
  // Return raw buffers for temporal coherence (only when not fast-previewing,
  // since the scaled canvas would be wrong dimensions for the next frame).
  if (isHertzmann && frameDiffThreshold > 0 && procW === origW && procH === origH) {
    out.canvasRGB = canvasRGB;
    out.srcRGB = srcRGB;
  }
  return out;
}

// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = async function (e) {
  const { type, imageData, params, prevState } = e.data;
  if (type !== 'render') return;

  try {
    if (params.algorithm === 'neural') ensureNeural();
    const result = await paintify(
      imageData,
      params,
      (progress) => self.postMessage({ type: 'progress', value: progress }),
      prevState || null,
      (message) => self.postMessage({ type: 'status', message })
    );
    const transfers = [result.data.buffer];
    if (result.canvasRGB) transfers.push(result.canvasRGB.buffer);
    if (result.srcRGB) transfers.push(result.srcRGB.buffer);
    self.postMessage({ type: 'done', result }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
