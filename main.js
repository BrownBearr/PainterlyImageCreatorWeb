'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let mode = 'image'; // 'image' | 'video' | 'batch'
let worker = null;
let videoProcessor = null;
let batchProcessor = null;
let isRendering = false;

let sourceImageData = null;
let texImageData    = null;
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
const texInput       = document.getElementById('tex-input');
const texLabel       = document.getElementById('tex-label');
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

function loadTexFile(file) {
  if (!file?.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const off = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    off.getContext('2d').drawImage(img, 0, 0);
    texImageData = off.getContext('2d').getImageData(0, 0, img.naturalWidth, img.naturalHeight);
    texLabel.textContent = `${file.name} (${img.naturalWidth}×${img.naturalHeight})`;
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function loadVideoFile(file) {
  if (!file?.type.startsWith('video/')) return;
  videoFile = file;
  videoInfo.textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
  updateButtonStates();
  setStatus('Video ready. Set FPS and click Process Video.');
}

function loadBatchFiles(files) {
  batchFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  batchInfo.textContent = batchFiles.length
    ? `${batchFiles.length} image${batchFiles.length > 1 ? 's' : ''} selected`
    : 'No valid images selected';
  updateButtonStates();
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

// ─── Texture ─────────────────────────────────────────────────────────────────

texInput.addEventListener('change', () => loadTexFile(texInput.files[0]));
document.getElementById('clear-tex').addEventListener('click', () => {
  texImageData = null; texInput.value = ''; texLabel.textContent = 'No texture loaded';
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
    fastPreview:     document.getElementById('fast-preview').checked,
    seed:            parseInt(document.getElementById('seed').value, 10) || 0,
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
    texImageData: texImageData
      ? { data: new Uint8ClampedArray(texImageData.data), width: texImageData.width, height: texImageData.height }
      : null,
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
    await videoProcessor.process(videoFile, getParams(), texImageData, fps);
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
    await batchProcessor.process(batchFiles, getParams(), texImageData);
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
 ['min-stroke-len','min-stroke-len-val'], ['video-fps','video-fps-val']]
  .forEach(([id, labelId]) => {
    const inp = document.getElementById(id), lbl = document.getElementById(labelId);
    if (!inp || !lbl) return;
    const sync = () => { lbl.textContent = inp.value; };
    inp.addEventListener('input', sync); sync();
  });

// ─── Init ─────────────────────────────────────────────────────────────────────

updateButtonStates();
setStatus('Upload an image to begin.');
progressWrap.style.display = 'none';
