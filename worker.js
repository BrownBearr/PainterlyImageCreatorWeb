'use strict';

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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

function drawCircle(mask, mw, mh, cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(mw - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(mh - 1, Math.ceil(cy + r + 1));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const ex = px - cx, ey = py - cy;
      const v = Math.max(0, Math.min(1, r - Math.sqrt(ex * ex + ey * ey) + 0.5));
      if (v > mask[py * mw + px]) mask[py * mw + px] = v;
    }
  }
}

function renderStrokeSolid(canvasRGB, pts, radius, color, opacity, w, h) {
  if (pts.length < 2) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of pts) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const pad = Math.ceil(radius) + 2;
  const bx0 = Math.max(0, minX - pad), by0 = Math.max(0, minY - pad);
  const bx1 = Math.min(w, maxX + pad + 1), by1 = Math.min(h, maxY + pad + 1);
  if (bx1 <= bx0 || by1 <= by0) return;

  const mw = bx1 - bx0, mh = by1 - by0;
  const mask = new Float32Array(mw * mh);

  for (let seg = 0; seg < pts.length - 1; seg++) {
    drawThickSegment(mask, mw, mh, pts[seg][0]-bx0, pts[seg][1]-by0, pts[seg+1][0]-bx0, pts[seg+1][1]-by0, radius);
  }
  drawCircle(mask, mw, mh, pts[0][0]-bx0, pts[0][1]-by0, radius);
  drawCircle(mask, mw, mh, pts[pts.length-1][0]-bx0, pts[pts.length-1][1]-by0, radius);

  const [sr, sg, sb] = color;
  for (let my = 0; my < mh; my++) {
    for (let mx = 0; mx < mw; mx++) {
      const a = Math.min(1, mask[my * mw + mx] * opacity);
      if (a <= 0) continue;
      const ci = ((by0 + my) * w + (bx0 + mx)) * 3;
      canvasRGB[ci]     = canvasRGB[ci]     * (1 - a) + sr * a;
      canvasRGB[ci + 1] = canvasRGB[ci + 1] * (1 - a) + sg * a;
      canvasRGB[ci + 2] = canvasRGB[ci + 2] * (1 - a) + sb * a;
    }
  }
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

// ─── Main paintify function ───────────────────────────────────────────────────

function paintify(imageData, params, onProgress) {
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

  const { brushRadii, threshold, maxStrokeLength, minStrokeLength,
          curvature, opacity, gridFactor, underpaintMode = 'average',
          hueJitter = 0, satJitter = 0, valJitter = 0 } = params;

  const radii = [...brushRadii].map(Number).filter(r => r >= 1).sort((a, b) => b - a);
  if (radii.length === 0) radii.push(4);

  const canvasRGB = new Float32Array(w * h * 3);

  if (underpaintMode === 'blur') {
    // Blur the source at the coarsest radius and use that as the starting canvas
    const blurSigma = Math.max(0.1, (radii[0] ?? 8) * 0.5);
    const blurred = gaussianBlurRGB(srcRGB, w, h, blurSigma);
    canvasRGB.set(blurred);
  } else if (underpaintMode === 'none') {
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

  for (let ri = 0; ri < radii.length; ri++) {
    const radius = Math.max(1, Math.round(radii[ri]));
    const sigma = Math.max(0.1, radius * 0.5);

    const refBlur = gaussianBlurRGB(srcRGB, w, h, sigma);
    const labRef = buildLabBuffer(refBlur, w, h);
    const { gx, gy, gmag } = computeGradients(refBlur, w, h);
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

      if (meanErr <= threshold && !isFirstLayer) continue;

      const { pts, color } = makeCurvedStroke(
        sx, sy, radius, refBlur, canvasRGB, gx, gy, gmag, w, h,
        { maxLen: maxStrokeLength, minLen: minStrokeLength, curvature }
      );

      let strokeColor = color;
      if (hueJitter > 0 || satJitter > 0 || valJitter > 0) {
        let [h2, s2, v2] = rgbToHsv(color[0], color[1], color[2]);
        h2 += (Math.random() * 2 - 1) * hueJitter;
        s2 = Math.max(0, Math.min(1, s2 + (Math.random() * 2 - 1) * satJitter));
        v2 = Math.max(0, Math.min(1, v2 + (Math.random() * 2 - 1) * valJitter));
        strokeColor = hsvToRgb(h2, s2, v2);
      }

      renderStrokeSolid(canvasRGB, pts, radius, strokeColor, opacity, w, h);
    }

    onProgress((ri + 1) / radii.length);
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

  return { data: resultData, width: origW, height: origH };
}

// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = function (e) {
  const { type, imageData, params } = e.data;
  if (type !== 'render') return;

  try {
    const result = paintify(
      imageData,
      params,
      (progress) => self.postMessage({ type: 'progress', value: progress })
    );
    self.postMessage({ type: 'done', result }, [result.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
