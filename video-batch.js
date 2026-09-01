'use strict';

// ─── Reusable painter worker wrapper ─────────────────────────────────────────

class PainterWorker {
  constructor() {
    this._w = new Worker('worker.js');
    this._pending = null;   // { resolve, reject, onProgress, onStatus }
    this._w.onmessage = (e) => {
      const { type } = e.data;
      const p = this._pending;
      if (!p) return;       // late message from a terminated/settled render — ignore
      if (type === 'progress') { p.onProgress?.(e.data.value); }
      else if (type === 'status') { p.onStatus?.(e.data.message); }
      else if (type === 'done') { this._pending = null; p.resolve(e.data.result); }
      else if (type === 'error') { this._pending = null; p.reject(new Error(e.data.message)); }
    };
    this._w.onerror = (e) => this._settleError(new Error(e.message || 'worker error'));
  }

  _settleError(err) {
    const p = this._pending;
    this._pending = null;
    p?.reject(err);
  }

  render(imageData, params, onProgress, prevState, onStatus) {
    // One render in flight per worker. The result is matched to the caller by
    // the single _pending slot, so an overlapping call would hand this frame's
    // result to the wrong promise — fail loudly instead of silently swapping
    // frames.
    if (this._pending) {
      return Promise.reject(new Error('PainterWorker is already rendering — one render at a time'));
    }
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject, onProgress: onProgress ?? null, onStatus: onStatus ?? null };
      const msg = {
        type: 'render',
        imageData: { data: new Uint8ClampedArray(imageData.data), width: imageData.width, height: imageData.height },
        params,
      };
      if (prevState) msg.prevState = prevState;
      this._w.postMessage(msg);
    });
  }

  // Terminating with a render in flight must reject it, otherwise the caller
  // awaits a promise that can never settle and the export hangs forever.
  terminate() {
    this._w.terminate();
    this._settleError(new Error('render cancelled'));
  }
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

async function imageDataToJpeg(imgData, quality = 0.92) {
  const canvas = new OffscreenCanvas(imgData.width, imgData.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(imgData.data), imgData.width, imgData.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
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

  async process(videoFile, params, fps) {
    this._cancelled = false;
    this._encoderError = null;

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

    const offscreen = new OffscreenCanvas(vw, vh);
    const octx = offscreen.getContext('2d');

    this._worker = new PainterWorker();

    let resultChunks = [];   // for WebCodecs path
    let zipWriter = null;    // for ZIP fallback
    let encoder = null;
    let lastTimestamp_us = -1; // monotonic guard — encoder rejects non-increasing timestamps

    if (hasWebCodecs) {
      const encChunks = [];
      encoder = new VideoEncoder({
        output: (chunk) => {
          const d = new Uint8Array(chunk.byteLength);
          chunk.copyTo(d);
          encChunks.push({ timestamp_us: chunk.timestamp, isKey: chunk.type === 'key', data: d });
        },
        // Throwing here cannot propagate to the awaiting caller — it would be
        // swallowed and the export would finish with a truncated file. Record
        // it and surface it at the next checkpoint instead.
        error: (e) => { this._encoderError = e; },
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
    //
    // Seek-and-draw only. An earlier version called play() and waited for
    // requestVideoFrameCallback to read the decoded frame's mediaTime, which
    // caused both of the export's symptoms:
    //
    //  - drawImage ran *after* pause(), a different moment than the callback,
    //    so the pixels drawn could be a later frame than the timestamp said —
    //    frames appearing duplicated or out of order.
    //  - timestamps taken from mediaTime are not on the output fps grid, and
    //    the muxer writes block timecodes straight from them at 1 ms
    //    resolution, so frame spacing came out irregular (33, 41, 33, 58 ms
    //    instead of a steady 33.3) — which is what the hitching was.
    //
    // After `seeked` the element's current frame is the seeked one and is ready
    // for drawImage, so no playback is needed. Timestamps come from the fps
    // grid, which is monotonic by construction and gives an exactly uniform
    // cadence. Resampling a video to a different fps legitimately repeats or
    // drops source frames; that is duplication, not misordering.
    let prevTemporalState = null; // { prevCanvasRGB, prevSrcRGB } for temporal coherence

    const seekTo = (t) => new Promise((res, rej) => {
      let done = false;
      const ok = () => { if (!done) { done = true; cleanup(); res(); } };
      const fail = () => { if (!done) { done = true; cleanup(); rej(new Error('seek failed')); } };
      const cleanup = () => {
        videoEl.removeEventListener('seeked', ok);
        videoEl.removeEventListener('error', fail);
        clearTimeout(timer);
      };
      // A seek that never completes would hang the whole export.
      const timer = setTimeout(ok, 5000);
      videoEl.addEventListener('seeked', ok, { once: true });
      videoEl.addEventListener('error', fail, { once: true });
      videoEl.currentTime = t;
    });

    for (let i = 0; i < totalFrames; i++) {
      if (this._cancelled) break;

      this._onStatus(`Painting frame ${i + 1} / ${totalFrames}`);

      await seekTo(i / fps);
      if (this._cancelled) break;

      // Fixed output cadence: frame i is presented at exactly i/fps.
      const timestamp_us = Math.round((i * 1_000_000) / fps);
      if (timestamp_us <= lastTimestamp_us) {
        // Only reachable at absurdly high fps where 1/fps rounds below 1 µs.
        throw new Error('fps too high for microsecond frame timestamps');
      }
      lastTimestamp_us = timestamp_us;

      octx.drawImage(videoEl, 0, 0);
      const frameData = octx.getImageData(0, 0, vw, vh);

      let painted;
      try {
        painted = await this._worker.render(frameData, params, (p) => {
          this._onFrameProgress(i, totalFrames, p);
        }, prevTemporalState);
      } catch (err) {
        // cancel() terminates the worker, which rejects the in-flight render.
        // That is expected here, not a failure to report.
        if (this._cancelled) break;
        throw err;
      }
      if (this._cancelled) break;

      // Update temporal state for next frame if the worker sent back raw buffers
      if (painted.canvasRGB && painted.srcRGB) {
        prevTemporalState = { prevCanvasRGB: painted.canvasRGB, prevSrcRGB: painted.srcRGB };
      } else {
        prevTemporalState = null;
      }

      if (encoder) {
        if (this._encoderError) throw this._encoderError;
        const imgd = new ImageData(new Uint8ClampedArray(painted.data), painted.width, painted.height);
        const bmp = await createImageBitmap(imgd);
        // duration lets the muxer/player know the intended frame length even
        // where a container rounds timecodes to milliseconds.
        const frame = new VideoFrame(bmp, { timestamp: timestamp_us, duration: Math.round(1_000_000 / fps) });
        bmp.close();
        encoder.encode(frame, { keyFrame: i % 30 === 0 });
        frame.close();
        // Back-pressure
        while (encoder.encodeQueueSize > 5 && !this._encoderError) {
          await new Promise(r => setTimeout(r, 16));
        }
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
      if (this._encoderError) throw this._encoderError;
      // The muxer sorts by timestamp, but out-of-order output would mean the
      // encoder emitted in decode order — worth knowing rather than silently
      // reordering, since it changes which frame each timecode belongs to.
      for (let k = 1; k < resultChunks.length; k++) {
        if (resultChunks[k].timestamp_us <= resultChunks[k - 1].timestamp_us) {
          console.warn('[video] encoder emitted chunks out of presentation order at', k);
          break;
        }
      }
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

  async process(files, params) {
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

      let painted;
      try {
        painted = await this._worker.render(imgData, params, (p) => {
          this._onFrameProgress(i, total, p);
        });
      } catch (err) {
        if (this._cancelled) break;   // cancel() rejects the in-flight render
        throw err;
      }
      if (this._cancelled) break;

      const stem = file.name.replace(/\.[^.]+$/, '');
      // Zero-pad the sequence index so output files sort correctly in any file browser.
      const outName = `${String(i + 1).padStart(padLen, '0')}_${stem}_painterly.jpg`;
      const jpg = await imageDataToJpeg(painted);

      if (dirHandle) {
        const fh = await dirHandle.getFileHandle(outName, { create: true });
        const w = await fh.createWritable();
        await w.write(jpg);
        await w.close();
      } else {
        zip.add(outName, jpg);
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
