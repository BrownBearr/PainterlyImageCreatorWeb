'use strict';

// ─── Neural SBR: Paint Transformer (Liu et al., ICCV 2021) ───────────────────
// In-browser stroke prediction via onnxruntime-web. Only the stroke-prediction
// transformer runs in the network (exported by tools/convert_paint_transformer.py);
// the patch pyramid, stroke decoding, color sampling, and rasterization are
// reimplemented here on top of the app's own stroke renderer, so neural
// strokes compose with brush textures, palette, jitter, and impasto.
//
// The model and the ORT wasm binaries are fetched from the CDN on first use
// and kept in the browser Cache API — repeat visits never re-download.
// Everything here is lazy: classic algorithms never load any of it.

const NEURAL_PATCH = 32;
const NEURAL_STROKES = 8;
const NEURAL_CDN_BASE = 'https://cdn.shivav.space/file/daysofshiva-source/painterly/';
const NEURAL_MODEL_URL = NEURAL_CDN_BASE + 'paint-transformer-v1.fp16.onnx';
const NEURAL_ORT_WASM_BASE = NEURAL_CDN_BASE + 'ort/1.27.0/';
const NEURAL_CACHE = 'painterly-neural-v1';
const NEURAL_BATCH = 64; // patches per inference call (bounds memory + lets progress tick)

let _neuralSession = null;        // cached ORT session (worker lives across video frames)
let _neuralSessionEP = null;      // which execution provider actually loaded

// Fetch a URL through the Cache API when available (workers have `caches`),
// reporting download progress for the big first-time fetch.
async function neuralFetchCached(url, onStatus) {
  let cache = null;
  if (typeof caches !== 'undefined') {
    try {
      cache = await caches.open(NEURAL_CACHE);
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
    } catch (e) { /* private mode etc. — fall through to plain fetch */ }
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Model download failed: HTTP ' + resp.status + ' for ' + url);
  const total = +resp.headers.get('content-length') || 0;
  let buf;
  if (total && resp.body) {
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onStatus && onStatus(`Downloading neural model… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
    buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    buf = buf.buffer;
  } else {
    buf = await resp.arrayBuffer();
  }
  if (cache) {
    try { await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })); }
    catch (e) { /* cache quota — non-fatal */ }
  }
  return buf;
}

async function neuralEnsureSession(onStatus) {
  if (_neuralSession) return _neuralSession;
  if (typeof ort === 'undefined') {
    throw new Error('onnxruntime-web is not loaded (vendor/ort/ort.min.js missing?)');
  }
  ort.env.wasm.wasmPaths = NEURAL_ORT_WASM_BASE;
  ort.env.wasm.numThreads = 1; // single-threaded: no COOP/COEP headers required

  onStatus && onStatus('Loading neural model…');
  const model = await neuralFetchCached(NEURAL_MODEL_URL, onStatus);

  // WebGPU when the browser exposes it in workers; wasm otherwise.
  const providers = (typeof navigator !== 'undefined' && navigator.gpu)
    ? ['webgpu', 'wasm'] : ['wasm'];
  let lastErr = null;
  for (const ep of providers) {
    try {
      onStatus && onStatus(`Starting neural engine (${ep})…`);
      _neuralSession = await ort.InferenceSession.create(model, { executionProviders: [ep] });
      _neuralSessionEP = ep;
      return _neuralSession;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Could not start onnxruntime: ' + (lastErr && lastErr.message));
}

// Bilinear sample of an RGB Float32Array at fractional pixel coords (may be
// outside — clamped). Matches grid_sample(align_corners=false) color pickup.
function neuralSampleRGB(rgb, w, h, fx, fy, out) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  for (let c = 0; c < 3; c++) {
    const a = rgb[(y0 * w + x0) * 3 + c] * (1 - tx) + rgb[(y0 * w + x1) * 3 + c] * tx;
    const b = rgb[(y1 * w + x0) * 3 + c] * (1 - tx) + rgb[(y1 * w + x1) * 3 + c] * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
}

// Resample source RGB (0..255) into an L×L layer image (0..1) representing the
// padded square: the image is centered in a padSize×padSize square (black
// borders), then scaled to L×L. Box-averages when shrinking.
function neuralLayerImage(rgb, w, h, padX, padY, padSize, L) {
  const out = new Float32Array(L * L * 3);
  const step = padSize / L;
  for (let y = 0; y < L; y++) {
    const sy0 = y * step - padY, sy1 = sy0 + step;
    const iy0 = Math.max(0, Math.floor(sy0)), iy1 = Math.min(h, Math.ceil(sy1));
    for (let x = 0; x < L; x++) {
      const sx0 = x * step - padX, sx1 = sx0 + step;
      const ix0 = Math.max(0, Math.floor(sx0)), ix1 = Math.min(w, Math.ceil(sx1));
      if (ix1 <= ix0 || iy1 <= iy0) continue; // outside the image: stays black
      let r = 0, g = 0, b = 0, n = 0;
      for (let iy = iy0; iy < iy1; iy++) {
        for (let ix = ix0; ix < ix1; ix++) {
          const si = (iy * w + ix) * 3;
          r += rgb[si]; g += rgb[si + 1]; b += rgb[si + 2]; n++;
        }
      }
      // Border texels average painted pixels with the black padding by area.
      const area = (sx1 - sx0) * (sy1 - sy0);
      const cover = n / Math.max(1, area);
      const inv = Math.min(1, cover) / (255 * Math.max(1, n));
      const di = (y * L + x) * 3;
      out[di] = r * inv; out[di + 1] = g * inv; out[di + 2] = b * inv;
    }
  }
  return out;
}

// Cut a P×P patch (3×P×P planar, NCHW) starting at (ox, oy) in an L×L layer
// image into `dst` at batch slot `slot`. Out-of-bounds pixels stay zero.
function neuralCutPatch(layer, L, ox, oy, dst, slot) {
  const P = NEURAL_PATCH, plane = P * P;
  const base = slot * 3 * plane;
  for (let y = 0; y < P; y++) {
    const sy = oy + y;
    if (sy < 0 || sy >= L) continue;
    for (let x = 0; x < P; x++) {
      const sx = ox + x;
      if (sx < 0 || sx >= L) continue;
      const si = (sy * L + sx) * 3, di = base + y * P + x;
      dst[di] = layer[si];
      dst[di + plane] = layer[si + 1];
      dst[di + 2 * plane] = layer[si + 2];
    }
  }
}

// Decode one batch of network outputs into strokes and paint them at full
// canvas resolution through the shared stroke rasterizer.
function neuralPaintStrokes(env, outParam, outDecision, origins, count, layerImg, L, scale, padX, padY, radiusIndex) {
  const { canvasRGB, w, h, params, palette, heightBuf, brushTex } = env;
  const { opacity, impastoStrength = 0 } = params;
  const P = NEURAL_PATCH;
  const col = new Float32Array(3);
  let painted = 0;

  for (let p = 0; p < count; p++) {
    const [ox, oy] = origins[p];
    for (let s = 0; s < NEURAL_STROKES; s++) {
      if (outDecision[p * NEURAL_STROKES + s] <= 0) continue;
      const o = (p * NEURAL_STROKES + s) * 5;
      const x = outParam[o], y = outParam[o + 1];
      const sw = outParam[o + 2], sh = outParam[o + 3], theta = outParam[o + 4];
      if (sw <= 0.01 || sh <= 0.01) continue;

      // Stroke center in layer pixels, then in full-canvas pixels.
      const lx = ox + x * P, ly = oy + y * P;
      const cx = lx * scale - padX, cy = ly * scale - padY;

      // Oriented capsule: long axis follows the brush orientation the model
      // chose (horizontal meta-brush when w >= h, vertical otherwise).
      const a = theta * Math.PI;
      let dx, dy, halfLen, radius;
      if (sw >= sh) { dx = Math.cos(a); dy = Math.sin(a); halfLen = sw * P * scale / 2; radius = Math.max(0.75, sh * P * scale / 2); }
      else { dx = -Math.sin(a); dy = Math.cos(a); halfLen = sh * P * scale / 2; radius = Math.max(0.75, sw * P * scale / 2); }

      // Cull by extent, not by center: coarse-layer strokes centered in the
      // padding can still cover a large part of the visible canvas.
      const reach = halfLen + radius;
      if (cx + reach < 0 || cy + reach < 0 || cx - reach > w || cy - reach > h) continue;
      // Capsule caps extend `radius` past each endpoint, so pull the endpoints
      // in to keep the stroke's total extent equal to the predicted length.
      halfLen = Math.max(halfLen - radius, radius * 0.25);

      // Color: sampled from the layer image at the stroke center (the model
      // was trained with this pickup), then through the shared color pipeline.
      // Clamp the sample point inside the actual image so strokes near the
      // border never pick up the black padding.
      const sx = (Math.max(0, Math.min(w - 1, cx)) + padX) / scale;
      const sy = (Math.max(0, Math.min(h - 1, cy)) + padY) / scale;
      neuralSampleRGB(layerImg, L, L, sx - 0.5, sy - 0.5, col);
      const color = finalizeStrokeColor(col[0] * 255, col[1] * 255, col[2] * 255, params, palette);

      const pts = [[cx - dx * halfLen, cy - dy * halfLen], [cx + dx * halfLen, cy + dy * halfLen]];
      renderStrokeSolid(canvasRGB, pts, radius, color, opacity, w, h,
                        heightBuf, impastoStrength, 0,
                        getStrokeTexture(brushTex, radiusIndex, cx, cy));
      painted++;
    }
  }
  return painted;
}

// Run inference for a list of patch origins (layer coords), chunked.
async function neuralRunPatches(env, session, layerImg, resultImg, L, origins, scale, padX, padY, radiusIndex, tickProgress) {
  const P = NEURAL_PATCH, plane = 3 * P * P;
  for (let start = 0; start < origins.length; start += NEURAL_BATCH) {
    const n = Math.min(NEURAL_BATCH, origins.length - start);
    const imgData = new Float32Array(n * plane);
    const canData = new Float32Array(n * plane);
    for (let i = 0; i < n; i++) {
      const [ox, oy] = origins[start + i];
      neuralCutPatch(layerImg, L, ox, oy, imgData, i);
      neuralCutPatch(resultImg, L, ox, oy, canData, i);
    }
    const feeds = {
      img: new ort.Tensor('float32', imgData, [n, 3, P, P]),
      canvas: new ort.Tensor('float32', canData, [n, 3, P, P]),
    };
    const out = await session.run(feeds);
    neuralPaintStrokes(env, out.param.data, out.decision.data,
                       origins.slice(start, start + n), n,
                       layerImg, L, scale, padX, padY, radiusIndex);
    tickProgress(n);
  }
}

async function paintNeural(env) {
  const { srcRGB, canvasRGB, w, h, params, onProgress } = env;
  const onStatus = env.onStatus || null;

  const session = await neuralEnsureSession(onStatus);
  onStatus && onStatus(`Painting with Paint Transformer (${_neuralSessionEP})…`);

  const P = NEURAL_PATCH;
  const maxLevels = Math.max(2, Math.min(6, Math.round(params.neuralLevels || 4)));
  // The padded square must cover the image (Kfull); the pyramid depth actually
  // run is capped by the Detail levels setting (fewer levels = faster/coarser).
  const Kfull = Math.max(0, Math.ceil(Math.log2(Math.max(w, h) / P)));
  const K = Math.min(maxLevels, Kfull);
  const padSize = P * (1 << Kfull);
  const padX = (padSize - w) / 2, padY = (padSize - h) / 2;

  // Canvas starts black — the model was trained to build up from darkness,
  // and its early decisions assume an empty canvas.
  canvasRGB.fill(0);

  // Progress: total patches across all layers plus the border pass.
  let totalPatches = 0;
  for (let layer = 0; layer <= K; layer++) totalPatches += (1 << layer) * (1 << layer);
  totalPatches += ((1 << K) + 1) * ((1 << K) + 1);
  let donePatches = 0;
  const tick = (n) => { donePatches += n; onProgress(Math.min(1, donePatches / totalPatches)); };

  for (let layer = 0; layer <= K; layer++) {
    const nSide = 1 << layer;
    const L = P * nSide;
    const scale = padSize / L;
    const layerImg = neuralLayerImage(srcRGB, w, h, padX, padY, padSize, L);
    const resultImg = neuralLayerImage(canvasRGB, w, h, padX, padY, padSize, L);
    const origins = [];
    for (let py = 0; py < nSide; py++) for (let px = 0; px < nSide; px++) origins.push([px * P, py * P]);
    await neuralRunPatches(env, session, layerImg, resultImg, L, origins, scale, padX, padY, layer, tick);
  }

  // Border pass: repeat the finest layer with patches shifted by half a patch,
  // so strokes can straddle the seams of the aligned grid.
  {
    const nSide = 1 << K;
    const L = P * nSide;
    const scale = padSize / L;
    const layerImg = neuralLayerImage(srcRGB, w, h, padX, padY, padSize, L);
    const resultImg = neuralLayerImage(canvasRGB, w, h, padX, padY, padSize, L);
    const origins = [];
    for (let py = 0; py <= nSide; py++) for (let px = 0; px <= nSide; px++) origins.push([px * P - P / 2, py * P - P / 2]);
    await neuralRunPatches(env, session, layerImg, resultImg, L, origins, scale, padX, padY, K, tick);
  }

  onProgress(1);
}
