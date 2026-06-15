'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let mode = 'image'; // 'image' | 'video' | 'batch'
let worker = null;
let videoProcessor = null;
let batchProcessor = null;
let isRendering = false;

let sourceImageData = null;
let maskImageData   = null;
let videoFile       = null;
let batchFiles      = [];
let resultBlob      = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const videoDropZone  = document.getElementById('video-drop-zone');
const videoInput     = document.getElementById('video-input');
const videoInfo      = document.getElementById('video-info');
const batchInput     = document.getElementById('batch-input');
const batchInfo      = document.getElementById('batch-info');
const canvas         = document.getElementById('output-canvas');
const ctx            = canvas.getContext('2d');
const renderBtn      = document.getElementById('render-btn');
const videoBtn       = document.getElementById('video-btn');
const batchBtn       = document.getElementById('batch-btn');
const cancelBtn      = document.getElementById('cancel-btn');
const downloadBtn    = document.getElementById('download-btn');
const progressWrap   = document.getElementById('progress-wrap');
const progressBar    = document.getElementById('progress-bar');
const frameProgressTrack = document.getElementById('frame-progress-track');
const frameProgressBar   = document.getElementById('frame-progress-bar');
const statusText     = document.getElementById('status-text');
const placeholder    = document.getElementById('placeholder');
const modeTabs       = document.querySelectorAll('.mode-tab');

// ─── Presets ──────────────────────────────────────────────────────────────────
// Edit values here to tune each preset.

const PRESETS = {
  impressionist: {
    // Curved medium strokes, moderate jitter — classic Monet/Renoir feel
    brushRadii: '8, 4, 2',
    maxStrokeLength: 16, minStrokeLength: 4,
    curvature: 1.0, threshold: 50, gridFactor: 1.0, opacity: 0.9,
    hueJitter: 0.05, satJitter: 0.1, valJitter: 0.1,
    underpaintMode: 'blur', fastPreview: false,
  },
  expressionist: {
    // Long, bold, highly curved strokes with strong color distortion — van Gogh / Munch
    brushRadii: '12, 6, 3',
    maxStrokeLength: 28, minStrokeLength: 8,
    curvature: 1.0, threshold: 40, gridFactor: 0.9, opacity: 0.95,
    hueJitter: 0.15, satJitter: 0.2, valJitter: 0.15,
    underpaintMode: 'blur', fastPreview: false,
  },
  pointillist: {
    // Very short strokes / dabs on a fine grid — Seurat / Signac
    brushRadii: '4, 2',
    maxStrokeLength: 3, minStrokeLength: 1,
    curvature: 0.0, threshold: 30, gridFactor: 0.75, opacity: 0.85,
    hueJitter: 0.1, satJitter: 0.15, valJitter: 0.1,
    underpaintMode: 'average', fastPreview: false,
  },
  wash: {
    // Large, translucent, high-jitter strokes — loose watercolour wash
    brushRadii: '20, 10',
    maxStrokeLength: 32, minStrokeLength: 10,
    curvature: 0.7, threshold: 80, gridFactor: 1.5, opacity: 0.4,
    hueJitter: 0.2, satJitter: 0.3, valJitter: 0.2,
    underpaintMode: 'blur', fastPreview: false,
  },
};

let _applyingPreset = false;

function setSlider(id, val) {
  const inp = document.getElementById(id);
  const lbl = document.getElementById(id + '-val');
  if (inp) inp.value = val;
  if (lbl) lbl.textContent = val;
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  _applyingPreset = true;
  document.getElementById('preset-select').value = key;
  document.getElementById('brush-radii').value = p.brushRadii;
  setSlider('max-stroke-len', p.maxStrokeLength);
  setSlider('min-stroke-len', p.minStrokeLength);
  setSlider('curvature', p.curvature);
  setSlider('threshold', p.threshold);
  setSlider('grid-factor', p.gridFactor);
  setSlider('opacity', p.opacity);
  setSlider('hue-jitter', p.hueJitter ?? 0);
  setSlider('sat-jitter', p.satJitter ?? 0);
  setSlider('val-jitter', p.valJitter ?? 0);
  document.getElementById('underpaint-mode').value = p.underpaintMode;
  document.getElementById('fast-preview').checked = p.fastPreview;
  _applyingPreset = false;
}

function markCustom() {
  if (_applyingPreset) return;
  const sel = document.getElementById('preset-select');
  if (sel.value !== 'custom') sel.value = 'custom';
}

// ─── Mode switching ───────────────────────────────────────────────────────────

modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (isRendering) return;
    mode = tab.dataset.mode;
    modeTabs.forEach(t => t.classList.toggle('active', t === tab));

    document.querySelectorAll('[data-panel]').forEach(p => {
      p.style.display = p.dataset.panel === mode ? '' : 'none';
    });

    // Show/hide mode-specific buttons
    renderBtn.style.display   = mode === 'image' ? '' : 'none';
    videoBtn.style.display    = mode === 'video' ? '' : 'none';
    batchBtn.style.display    = mode === 'batch' ? '' : 'none';
    downloadBtn.style.display = mode === 'image' ? '' : 'none';

    // Reset progress
    progressWrap.style.display = 'none';
    frameProgressTrack.style.display = 'none';

    updateButtonStates();
    setStatus(mode === 'image' ? 'Upload an image to begin.'
            : mode === 'video' ? 'Upload a video to begin.'
            :                    'Select images to begin.');
  });
});

// ─── Image loading ────────────────────────────────────────────────────────────

function loadImageFile(file) {
  if (!file?.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const off = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    off.getContext('2d').drawImage(img, 0, 0);
    sourceImageData = off.getContext('2d').getImageData(0, 0, img.naturalWidth, img.naturalHeight);

    placeholder.style.display = 'none';
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    resultBlob = null;
    downloadBtn.disabled = true;
    updateButtonStates();
    setStatus(`Image: ${img.naturalWidth}×${img.naturalHeight}px`);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function loadVideoFile(file) {
  if (!file?.type.startsWith('video/')) return;
  clearThumbState(); // invalidate any previous thumbnails + tuned-frame state
  videoFile = file;
  videoInfo.textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
  updateButtonStates();
  setStatus('Video ready. Generating sample frames…');
  generateThumbnails(file).catch(err => {
    console.warn('Thumbnail generation failed:', err);
    setStatus('Video ready. (Thumbnail preview unavailable.)');
  });
}

function loadBatchFiles(files) {
  batchFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  batchInfo.textContent = batchFiles.length
    ? `${batchFiles.length} image${batchFiles.length > 1 ? 's' : ''} selected`
    : 'No valid images selected';
  updateButtonStates();
}

// ─── Video frame-test thumbnails ─────────────────────────────────────────────
// Frame extraction reuses the same seek-and-draw primitive as VideoProcessor,
// but operates on a dedicated HTMLVideoElement kept alive for the session so
// the user can click any thumbnail at any time without re-seeking from scratch.

const THUMB_PCTS = [0, 0.25, 0.5, 0.75, 1.0];
let _thumbVid     = null;   // video element kept alive for seek-based frame loading
let _thumbUrls    = [];     // blob URLs for the 5 thumbnails (revoked on new load)
let tunedOnFramePct = null; // which % frame was sent to the Image tab, or null

function clearThumbState() {
  if (_thumbVid) { _thumbVid.src = ''; _thumbVid = null; }
  _thumbUrls.forEach(u => URL.revokeObjectURL(u));
  _thumbUrls = [];
  tunedOnFramePct = null;
  document.getElementById('thumb-row').innerHTML = '';
  document.getElementById('thumb-strip').style.display = 'none';
  updateVideoBtnLabel();
}

async function generateThumbnails(file) {
  const vid = document.createElement('video');
  vid.muted = true;
  vid.preload = 'metadata';
  // Create an object URL and keep it alive via the element reference.
  // Revoked only in clearThumbState() when a new video is loaded.
  const objUrl = URL.createObjectURL(file);
  _thumbUrls.push(objUrl); // track so we can revoke later
  vid.src = objUrl;
  _thumbVid = vid;

  await new Promise((res, rej) => {
    vid.onloadedmetadata = res;
    vid.onerror = () => rej(new Error('Cannot read video for thumbnails'));
  });

  const { videoWidth: vw, videoHeight: vh, duration } = vid;
  const thumbW = 100;
  const thumbH = Math.max(1, Math.round(thumbW * vh / vw));
  const off = new OffscreenCanvas(thumbW, thumbH);
  const octx = off.getContext('2d');

  const thumbRow  = document.getElementById('thumb-row');
  const thumbStrip = document.getElementById('thumb-strip');
  thumbRow.innerHTML = '';

  for (const pct of THUMB_PCTS) {
    // Clamp near end to avoid seeking past EOF on some codecs
    const t = pct >= 1 ? Math.max(0, duration - 0.05) : duration * pct;
    vid.currentTime = t;
    await new Promise(res => vid.addEventListener('seeked', res, { once: true }));

    octx.drawImage(vid, 0, 0, thumbW, thumbH);
    const blob    = await off.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const thumbUrl = URL.createObjectURL(blob);
    _thumbUrls.push(thumbUrl);

    const wrapper = document.createElement('div');
    wrapper.className = 'thumb-wrapper';
    wrapper.title = `${Math.round(pct * 100)}% into video — click to load into Image tab`;

    const img = document.createElement('img');
    img.src = thumbUrl;
    img.className = 'thumb-img';
    img.draggable = false;

    const lbl = document.createElement('span');
    lbl.className = 'thumb-label';
    lbl.textContent = Math.round(pct * 100) + '%';

    wrapper.append(img, lbl);
    wrapper.addEventListener('click', () => loadFrameIntoImageTab(pct));
    thumbRow.appendChild(wrapper);

    // Show the strip as soon as the first thumb is ready
    if (thumbStrip.style.display === 'none') thumbStrip.style.display = '';
  }

  setStatus('Video ready. Click a frame to tune, then switch back to render.');
}

async function loadFrameIntoImageTab(pct) {
  if (!_thumbVid) return;
  const vid = _thumbVid;
  const { videoWidth: vw, videoHeight: vh, duration } = vid;

  const t = pct >= 1 ? Math.max(0, duration - 0.05) : duration * pct;
  vid.currentTime = t;
  await new Promise(res => vid.addEventListener('seeked', res, { once: true }));

  // Extract full-resolution frame
  const off = new OffscreenCanvas(vw, vh);
  off.getContext('2d').drawImage(vid, 0, 0, vw, vh);
  sourceImageData = off.getContext('2d').getImageData(0, 0, vw, vh);

  // Show on the main canvas
  placeholder.style.display = 'none';
  canvas.width = vw; canvas.height = vh;
  ctx.putImageData(sourceImageData, 0, 0);
  resultBlob = null;
  downloadBtn.disabled = true;

  // Record which frame was tuned and update the video button label
  tunedOnFramePct = pct;
  updateVideoBtnLabel();

  // Highlight the selected thumbnail
  document.querySelectorAll('.thumb-wrapper').forEach(w => {
    w.classList.toggle('thumb-active', parseFloat(w.dataset.pct ?? -1) === pct);
  });

  // Switch to Image tab (the click handler sets mode + status)
  document.querySelector('.mode-tab[data-mode="image"]').click();
  // Override the generic status with something more useful
  setStatus(`Frame at ${Math.round(pct * 100)}% loaded — tune, then return to Video tab.`);
  updateButtonStates();
}

function updateVideoBtnLabel() {
  if (tunedOnFramePct !== null) {
    videoBtn.textContent = `▶ Tuned on ${Math.round(tunedOnFramePct * 100)}% frame · Render full video`;
  } else {
    videoBtn.textContent = '▶ Process Video';
  }
}

// ─── Drag & drop — image ──────────────────────────────────────────────────────

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); loadImageFile(e.dataTransfer.files[0]); });
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => loadImageFile(fileInput.files[0]));

// ─── Drag & drop — video ──────────────────────────────────────────────────────

videoDropZone.addEventListener('dragover', e => { e.preventDefault(); videoDropZone.classList.add('drag-over'); });
videoDropZone.addEventListener('dragleave', () => videoDropZone.classList.remove('drag-over'));
videoDropZone.addEventListener('drop', e => { e.preventDefault(); videoDropZone.classList.remove('drag-over'); loadVideoFile(e.dataTransfer.files[0]); });
videoDropZone.addEventListener('click', () => videoInput.click());
videoInput.addEventListener('change', () => loadVideoFile(videoInput.files[0]));

// ─── Batch ────────────────────────────────────────────────────────────────────

batchInput.addEventListener('change', () => loadBatchFiles(batchInput.files));

// ─── Mask loading ────────────────────────────────────────────────────────────

function loadMaskFile(file) {
  if (!file?.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const off = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    off.getContext('2d').drawImage(img, 0, 0);
    maskImageData = off.getContext('2d').getImageData(0, 0, img.naturalWidth, img.naturalHeight);
    document.getElementById('mask-label').textContent = `${file.name} (${img.naturalWidth}×${img.naturalHeight})`;
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

document.getElementById('mask-input').addEventListener('change', (e) => loadMaskFile(e.target.files[0]));
document.getElementById('clear-mask').addEventListener('click', () => {
  maskImageData = null;
  document.getElementById('mask-input').value = '';
  document.getElementById('mask-label').textContent = 'No mask loaded';
});

// ─── Parameter reading ────────────────────────────────────────────────────────

function getParams() {
  const radiiRaw = document.getElementById('brush-radii').value;
  const brushRadii = radiiRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0 && isFinite(n));
  return {
    brushRadii:      brushRadii.length ? brushRadii : [8, 4, 2],
    threshold:       parseFloat(document.getElementById('threshold').value) || 50,
    maxStrokeLength: parseInt(document.getElementById('max-stroke-len').value, 10) || 16,
    minStrokeLength: parseInt(document.getElementById('min-stroke-len').value, 10) || 4,
    curvature:       parseFloat(document.getElementById('curvature').value) ?? 1.0,
    opacity:         parseFloat(document.getElementById('opacity').value) ?? 0.9,
    gridFactor:      parseFloat(document.getElementById('grid-factor').value) ?? 1.0,
    hueJitter:            parseFloat(document.getElementById('hue-jitter').value) || 0,
    satJitter:            parseFloat(document.getElementById('sat-jitter').value) || 0,
    valJitter:            parseFloat(document.getElementById('val-jitter').value) || 0,
    frameDiffThreshold:   parseFloat(document.getElementById('frame-diff').value) || 0,
    maskData:   maskImageData ? new Uint8ClampedArray(maskImageData.data) : null,
    maskWidth:  maskImageData ? maskImageData.width  : 0,
    maskHeight: maskImageData ? maskImageData.height : 0,
    impastoStrength:      parseFloat(document.getElementById('impasto-strength').value) || 0,
    impastoLightStrength: parseFloat(document.getElementById('impasto-light').value) || 0,
    lightAngle:           parseFloat(document.getElementById('light-angle').value) || 45,
    fastPreview:          document.getElementById('fast-preview').checked,
    underpaintMode:  document.getElementById('underpaint-mode').value,
  };
}

// ─── Image rendering ──────────────────────────────────────────────────────────

function startImageRender() {
  if (!sourceImageData || isRendering) return;
  isRendering = true;
  updateButtonStates();
  progressWrap.style.display = 'block';
  frameProgressTrack.style.display = 'none';
  setProgress(0);
  setStatus('Rendering…');
  resultBlob = null;
  downloadBtn.disabled = true;

  const id = sourceImageData;
  if (worker) worker.terminate();
  worker = new Worker('worker.js');

  worker.onmessage = (e) => {
    if (e.data.type === 'progress') {
      setProgress(e.data.value);
    } else if (e.data.type === 'done') {
      const { data, width, height } = e.data.result;
      const rid = new ImageData(new Uint8ClampedArray(data), width, height);
      canvas.width = width; canvas.height = height;
      ctx.putImageData(rid, 0, 0);
      placeholder.style.display = 'none';
      canvas.toBlob(blob => { resultBlob = blob; downloadBtn.disabled = false; }, 'image/png');
      setProgress(1); setStatus('Done.');
      finishRender();
    } else if (e.data.type === 'error') {
      setStatus('Error: ' + e.data.message); finishRender();
    }
  };
  worker.onerror = (e) => { setStatus('Worker error: ' + e.message); finishRender(); };

  worker.postMessage({
    type: 'render',
    imageData: { data: new Uint8ClampedArray(id.data), width: id.width, height: id.height },
    params: getParams(),
  });
}

// ─── Video processing ─────────────────────────────────────────────────────────

async function startVideoProcess() {
  if (!videoFile || isRendering) return;
  isRendering = true;
  updateButtonStates();
  progressWrap.style.display = 'block';
  frameProgressTrack.style.display = 'block';
  setProgress(0); setFrameProgress(0);
  setStatus('Starting video processing…');

  const fps = parseInt(document.getElementById('video-fps').value, 10) || 24;

  videoProcessor = new VideoProcessor({
    onStatus: setStatus,
    onFrameProgress: (frameIdx, total, inner) => {
      setProgress(frameIdx / total);
      setFrameProgress(inner);
      frameProgressBar.title = `Frame ${frameIdx + 1}/${total} · ${Math.round(inner * 100)}% painted`;
    },
  });

  try {
    await videoProcessor.process(videoFile, getParams(), fps);
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
  finishRender();
}

// ─── Batch processing ─────────────────────────────────────────────────────────

async function startBatchProcess() {
  if (!batchFiles.length || isRendering) return;
  isRendering = true;
  updateButtonStates();
  progressWrap.style.display = 'block';
  frameProgressTrack.style.display = 'block';
  setProgress(0); setFrameProgress(0);
  setStatus('Starting batch…');

  batchProcessor = new BatchProcessor({
    onStatus: setStatus,
    onFrameProgress: (idx, total, inner) => {
      setProgress(idx / total);
      setFrameProgress(inner);
    },
  });

  try {
    await batchProcessor.process(batchFiles, getParams());
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
  finishRender();
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

function cancelAll() {
  worker?.terminate(); worker = null;
  videoProcessor?.cancel(); videoProcessor = null;
  batchProcessor?.cancel(); batchProcessor = null;
  setStatus('Cancelled.');
  finishRender();
}

function finishRender() {
  isRendering = false;
  updateButtonStates();
}

// ─── Download (image mode) ────────────────────────────────────────────────────

function downloadImage() {
  if (!resultBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(resultBlob);
  a.download = 'painterly.png';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Button wiring ────────────────────────────────────────────────────────────

renderBtn.addEventListener('click', startImageRender);
videoBtn.addEventListener('click', startVideoProcess);
batchBtn.addEventListener('click', startBatchProcess);
cancelBtn.addEventListener('click', cancelAll);
downloadBtn.addEventListener('click', downloadImage);

// ─── UI helpers ───────────────────────────────────────────────────────────────

function updateButtonStates() {
  renderBtn.disabled   = isRendering || !sourceImageData;
  videoBtn.disabled    = isRendering || !videoFile;
  batchBtn.disabled    = isRendering || !batchFiles.length;
  cancelBtn.disabled   = !isRendering;
  downloadBtn.disabled = isRendering || !resultBlob;
}

function setProgress(v) { progressBar.style.width = `${Math.round(v * 100)}%`; }
function setFrameProgress(v) { frameProgressBar.style.width = `${Math.round(v * 100)}%`; }
function setStatus(msg) { statusText.textContent = msg; }

// ─── Slider label sync ────────────────────────────────────────────────────────

[['threshold','threshold-val'], ['curvature','curvature-val'], ['opacity','opacity-val'],
 ['grid-factor','grid-factor-val'], ['max-stroke-len','max-stroke-len-val'],
 ['min-stroke-len','min-stroke-len-val'], ['video-fps','video-fps-val'],
 ['hue-jitter','hue-jitter-val'], ['sat-jitter','sat-jitter-val'], ['val-jitter','val-jitter-val'],
 ['impasto-strength','impasto-strength-val'], ['impasto-light','impasto-light-val'], ['light-angle','light-angle-val'],
 ['frame-diff','frame-diff-val']]
  .forEach(([id, labelId]) => {
    const inp = document.getElementById(id), lbl = document.getElementById(labelId);
    if (!inp || !lbl) return;
    const sync = () => { lbl.textContent = inp.value; };
    inp.addEventListener('input', sync); sync();
  });

// ─── Init ─────────────────────────────────────────────────────────────────────

applyPreset('impressionist');

// Preset dropdown → apply preset or no-op on "Custom"
document.getElementById('preset-select').addEventListener('change', (e) => {
  if (e.target.value !== 'custom') applyPreset(e.target.value);
});

// Any manual param edit → switch dropdown to Custom
['brush-radii', 'max-stroke-len', 'min-stroke-len', 'curvature',
 'threshold', 'grid-factor', 'opacity', 'hue-jitter', 'sat-jitter', 'val-jitter',
 'impasto-strength', 'impasto-light', 'light-angle', 'underpaint-mode', 'fast-preview']
  .forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input',  markCustom);
    el.addEventListener('change', markCustom);
  });

updateButtonStates();
setStatus('Upload an image to begin.');
progressWrap.style.display = 'none';
