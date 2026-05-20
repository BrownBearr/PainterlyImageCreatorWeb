'use strict';

// ─── Reusable painter worker wrapper ─────────────────────────────────────────

class PainterWorker {
  constructor() {
    this._w = new Worker('worker.js');
    this._resolve = null;
    this._reject = null;
    this._onProgress = null;
    this._w.onmessage = (e) => {
      const { type } = e.data;
      if (type === 'progress') { this._onProgress?.(e.data.value); }
      else if (type === 'done') { this._resolve?.(e.data.result); }
      else if (type === 'error') { this._reject?.(new Error(e.data.message)); }
    };
    this._w.onerror = (e) => this._reject?.(e);
  }

  render(imageData, params, texImageData, onProgress) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._onProgress = onProgress ?? null;
      this._w.postMessage({
        type: 'render',
        imageData: { data: new Uint8ClampedArray(imageData.data), width: imageData.width, height: imageData.height },
        texImageData: texImageData
          ? { data: new Uint8ClampedArray(texImageData.data), width: texImageData.width, height: texImageData.height }
          : null,
        params,
      });
    });
  }

  terminate() { this._w.terminate(); }
}

// ─── Minimal ZIP writer (STORE, no compression) ───────────────────────────────

class ZipWriter {
  constructor() {
    this._entries = [];
    this._central = [];
    this._offset = 0;
  }

  _u16le(v) { return [(v) & 0xFF, (v >> 8) & 0xFF]; }
  _u32le(v) { v = v >>> 0; return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }

  _crc32(data) {
    if (!ZipWriter._table) {
      ZipWriter._table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        ZipWriter._table[n] = c;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ ZipWriter._table[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  add(filename, data /* Uint8Array */) {
    const enc = new TextEncoder().encode(filename);
    const crc = this._crc32(data);
    const size = data.length;
    const u16 = this._u16le.bind(this), u32 = this._u32le.bind(this);

    const local = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04,  // local file header sig
      0x14, 0x00,               // version needed
      0x00, 0x00,               // flags
      0x00, 0x00,               // compression: STORE
      0x00, 0x00, 0x00, 0x00,  // mod time + date
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(enc.length), 0x00, 0x00,  // name len, extra len
    ]);

    const central = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02,  // central dir sig
      0x14, 0x00,               // version made by
      0x14, 0x00,               // version needed
      0x00, 0x00,               // flags
      0x00, 0x00,               // compression
      0x00, 0x00, 0x00, 0x00,  // mod time + date
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(enc.length),
      0x00, 0x00,               // extra len
      0x00, 0x00,               // comment len
      0x00, 0x00,               // disk start
      0x00, 0x00,               // internal attrs
      0x00, 0x00, 0x00, 0x00,  // external attrs
      ...u32(this._offset),    // local header offset
    ]);

    const localFull = _concat(local, enc, data);
    this._entries.push(localFull);
    this._central.push(_concat(central, enc));
    this._offset += localFull.length;
  }

  finish() {
    const cd = _concat(...this._central);
    const n = this._entries.length;
    const u16 = this._u16le.bind(this), u32 = this._u32le.bind(this);
    const eocd = new Uint8Array([
      0x50, 0x4B, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
      ...u16(n), ...u16(n),
      ...u32(cd.length), ...u32(this._offset),
      0x00, 0x00,
    ]);
    return _concat(...this._entries, cd, eocd);
  }
}

function _concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function imageDataToPng(imgData) {
  const canvas = new OffscreenCanvas(imgData.width, imgData.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(imgData.data), imgData.width, imgData.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function triggerDownload(data /* Uint8Array | Blob */, filename) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─── Video Processor ──────────────────────────────────────────────────────────

class VideoProcessor {
  constructor({ onStatus, onFrameProgress }) {
    this._onStatus = onStatus;
    this._onFrameProgress = onFrameProgress; // (frameIdx, totalFrames, innerProgress)
    this._cancelled = false;
    this._worker = null;
  }

  cancel() {
    this._cancelled = true;
    this._worker?.terminate();
    this._worker = null;
  }

  async process(videoFile, params, texImageData, fps) {
    this._cancelled = false;

    // ── 1. Load video metadata ─────────────────────────────────────────────
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.preload = 'auto';
    const videoUrl = URL.createObjectURL(videoFile);
    videoEl.src = videoUrl;

    await new Promise((res, rej) => {
      videoEl.onloadedmetadata = res;
      videoEl.onerror = () => rej(new Error('Failed to load video'));
    });

    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const duration = videoEl.duration;
    const totalFrames = Math.round(duration * fps);

    if (!vw || !vh || !totalFrames) throw new Error('Could not read video dimensions or duration');

    this._onStatus(`Video: ${vw}×${vh} · ${duration.toFixed(1)}s · ${totalFrames} frames @ ${fps} fps`);

    // ── 2. Decide encoding strategy ────────────────────────────────────────
    const hasWebCodecs = typeof VideoEncoder !== 'undefined';
    const hasRVFC = typeof videoEl.requestVideoFrameCallback === 'function';

    const offscreen = new OffscreenCanvas(vw, vh);
    const octx = offscreen.getContext('2d');

    this._worker = new PainterWorker();

    let resultChunks = [];   // for WebCodecs path
    let zipWriter = null;    // for ZIP fallback
    let encoder = null;

    if (hasWebCodecs) {
      const encChunks = [];
      encoder = new VideoEncoder({
        output: (chunk) => {
          const d = new Uint8Array(chunk.byteLength);
          chunk.copyTo(d);
          encChunks.push({ timestamp_us: chunk.timestamp, isKey: chunk.type === 'key', data: d });
        },
        error: (e) => { throw e; },
      });

      // Try VP8 first, fall back to VP9
      let configured = false;
      for (const codec of ['vp8', 'vp09.00.10.08']) {
        const support = await VideoEncoder.isConfigSupported({ codec, width: vw, height: vh });
        if (support.supported) {
          encoder.configure({ codec, width: vw, height: vh, bitrate: 6_000_000, framerate: fps, latencyMode: 'quality' });
          resultChunks = encChunks;
          configured = true;
          this._codec = codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8';
          break;
        }
      }
      if (!configured) {
        encoder.close(); encoder = null;
        this._onStatus('WebCodecs VP8/VP9 unsupported — falling back to PNG ZIP');
        zipWriter = new ZipWriter();
      }
    } else {
      zipWriter = new ZipWriter();
    }

    // ── 3. Frame-by-frame: extract → paint → encode/collect ───────────────
    // We seek to each target time and use requestVideoFrameCallback (when
    // available) to get the actual presented frame's mediaTime, avoiding the
    // keyframe-landing duplicate-frame problem that seek-only extraction causes.
    for (let i = 0; i < totalFrames; i++) {
      if (this._cancelled) break;

      this._onStatus(`Painting frame ${i + 1} / ${totalFrames}`);

      const targetTime = i / fps;
      videoEl.currentTime = targetTime;
      await new Promise((res) => videoEl.addEventListener('seeked', res, { once: true }));
      if (this._cancelled) break;

      // Use rVFC to get the exact mediaTime of the frame the browser actually
      // decoded — this prevents using a stale/keyframe time as the timestamp.
      let timestamp_us;
      if (hasRVFC) {
        // After seeked fires, rVFC will call back on the next presented frame.
        // We must call play() briefly to trigger frame presentation; we pause
        // immediately inside the callback to keep playback frozen.
        const meta = await new Promise((res) => {
          videoEl.requestVideoFrameCallback((_, m) => {
            videoEl.pause();
            res(m);
          });
          videoEl.play().catch(() => {});
        });
        timestamp_us = Math.round(meta.mediaTime * 1_000_000);
      } else {
        // Fallback: use the seek target time (may have small inaccuracies but
        // produces monotonically-increasing timestamps which is what matters most).
        timestamp_us = Math.round(targetTime * 1_000_000);
      }

      octx.drawImage(videoEl, 0, 0);
      const frameData = octx.getImageData(0, 0, vw, vh);

      const painted = await this._worker.render(frameData, params, texImageData, (p) => {
        this._onFrameProgress(i, totalFrames, p);
      });
      if (this._cancelled) break;

      if (encoder) {
        const imgd = new ImageData(new Uint8ClampedArray(painted.data), painted.width, painted.height);
        const bmp = await createImageBitmap(imgd);
        const frame = new VideoFrame(bmp, { timestamp: timestamp_us });
        bmp.close();
        encoder.encode(frame, { keyFrame: i % 30 === 0 });
        frame.close();
        // Back-pressure
        while (encoder.encodeQueueSize > 5) await new Promise(r => setTimeout(r, 16));
      } else {
        // PNG fallback
        this._onStatus(`Encoding frame ${i + 1} / ${totalFrames} as PNG…`);
        const png = await imageDataToPng(painted);
        zipWriter.add(`frame_${String(i + 1).padStart(5, '0')}.png`, png);
      }
    }

    URL.revokeObjectURL(videoUrl);
    this._worker.terminate();
    this._worker = null;

    if (this._cancelled) { this._onStatus('Cancelled.'); return; }

    // ── 4. Finish encoding / muxing ────────────────────────────────────────
    if (encoder) {
      this._onStatus('Flushing encoder…');
      await encoder.flush();
      encoder.close();
      this._onStatus('Muxing WebM…');
      const webm = muxWebM(resultChunks, vw, vh, fps, this._codec ?? 'V_VP8');
      triggerDownload(webm, 'painterly.webm');
      this._onStatus(`Done — ${resultChunks.length} frames, ${(webm.length / 1e6).toFixed(1)} MB.`);
    } else if (zipWriter) {
      this._onStatus('Building ZIP…');
      const zip = zipWriter.finish();
      triggerDownload(zip, 'painterly-frames.zip');
      this._onStatus(`Done — ${totalFrames} PNG frames downloaded as ZIP.`);
    }
  }
}

// ─── Batch Processor ──────────────────────────────────────────────────────────

class BatchProcessor {
  constructor({ onStatus, onFrameProgress }) {
    this._onStatus = onStatus;
    this._onFrameProgress = onFrameProgress;
    this._cancelled = false;
    this._worker = null;
  }

  cancel() {
    this._cancelled = true;
    this._worker?.terminate();
    this._worker = null;
  }

  async process(files, params, texImageData) {
    this._cancelled = false;
    this._worker = new PainterWorker();

    // Try File System Access API first
    let dirHandle = null;
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch {
        // User cancelled picker or API unavailable → fall back to ZIP
      }
    }

    // Sort files numerically by the last digit group in the filename so that
    // frame_001.png < frame_002.png < … < frame_010.png (not lexicographic order).
    const sortedFiles = [...files].sort((a, b) => {
      const key = (f) => {
        const stem = f.name.replace(/\.[^.]+$/, '');
        const nums = stem.match(/\d+/g);
        // Files with a trailing number sort before those without, then by that number.
        return nums
          ? [0, parseInt(nums[nums.length - 1], 10), stem.toLowerCase()]
          : [1, 0, stem.toLowerCase()];
      };
      const ka = key(a), kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
    });

    const zip = dirHandle ? null : new ZipWriter();
    const total = sortedFiles.length;
    const padLen = String(total).length;

    for (let i = 0; i < total; i++) {
      if (this._cancelled) break;

      const file = sortedFiles[i];
      this._onStatus(`Processing ${file.name} (${i + 1} / ${total})`);

      // Load image
      const imgData = await loadFileAsImageData(file);
      if (!imgData) { this._onStatus(`Skipping ${file.name} — not a valid image.`); continue; }

      const painted = await this._worker.render(imgData, params, texImageData, (p) => {
        this._onFrameProgress(i, total, p);
      });
      if (this._cancelled) break;

      const stem = file.name.replace(/\.[^.]+$/, '');
      // Zero-pad the sequence index so output files sort correctly in any file browser.
      const outName = `${String(i + 1).padStart(padLen, '0')}_${stem}_painterly.png`;
      const png = await imageDataToPng(painted);

      if (dirHandle) {
        const fh = await dirHandle.getFileHandle(outName, { create: true });
        const w = await fh.createWritable();
        await w.write(png);
        await w.close();
      } else {
        zip.add(outName, png);
      }
    }

    this._worker.terminate();
    this._worker = null;

    if (this._cancelled) { this._onStatus('Cancelled.'); return; }

    if (zip) {
      this._onStatus('Building ZIP…');
      const data = zip.finish();
      triggerDownload(data, 'painterly-batch.zip');
      this._onStatus(`Done — ${total} images downloaded as ZIP.`);
    } else {
      this._onStatus(`Done — ${total} images saved to folder.`);
    }
  }
}

async function loadFileAsImageData(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c.getContext('2d').getImageData(0, 0, img.naturalWidth, img.naturalHeight));
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ─── Exports (globals) ───────────────────────────────────────────────────────

window.VideoProcessor = VideoProcessor;
window.BatchProcessor = BatchProcessor;
window.triggerDownload = triggerDownload;
