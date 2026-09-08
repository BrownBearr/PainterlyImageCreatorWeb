'use strict';

// Shared between tools/parity.html (browser) and tools/parity-node.js (CLI).
// Defines the deterministic test image, the config matrix, the hash, and the
// committed baseline hashes. Names are PARITY_-prefixed so this file can be
// evaluated alongside worker.js without collisions.

const PARITY_W = 320;
const PARITY_H = 240;

function parityRng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Procedural test image: color gradient + bilinear value noise + disks.
// Fully deterministic — no binary fixture needed.
function makeParityImage(w = PARITY_W, h = PARITY_H) {
  const rng = parityRng(1234567);
  const gw = 9, gh = 7;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const disks = [];
  for (let i = 0; i < 5; i++) {
    disks.push({
      x: rng() * w, y: rng() * h, r: 15 + rng() * 40,
      cr: rng() * 255, cg: rng() * 255, cb: rng() * 255,
    });
  }

  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Bilinear noise sample
      const u = (x / w) * (gw - 1), v = (y / h) * (gh - 1);
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const fx = u - x0, fy = v - y0;
      const g00 = grid[y0 * gw + x0], g10 = grid[y0 * gw + Math.min(gw - 1, x0 + 1)];
      const g01 = grid[Math.min(gh - 1, y0 + 1) * gw + x0];
      const g11 = grid[Math.min(gh - 1, y0 + 1) * gw + Math.min(gw - 1, x0 + 1)];
      const n = (g00 * (1 - fx) + g10 * fx) * (1 - fy) + (g01 * (1 - fx) + g11 * fx) * fy;

      let r = 40 + (x / w) * 180 + n * 60;
      let g = 60 + (y / h) * 140 + n * 40;
      let b = 200 - (x / w) * 120 + n * 50;

      for (const d of disks) {
        const dx = x - d.x, dy = y - d.y;
        if (dx * dx + dy * dy < d.r * d.r) { r = d.cr; g = d.cg; b = d.cb; }
      }

      const i4 = (y * w + x) * 4;
      data[i4] = r; data[i4 + 1] = g; data[i4 + 2] = b; data[i4 + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// FNV-1a 32-bit over the output RGBA buffer.
function parityHash(u8) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    hsh ^= u8[i];
    hsh = Math.imul(hsh, 0x01000193);
  }
  return ('00000000' + (hsh >>> 0).toString(16)).slice(-8);
}

// Baseline params: every field worker.js reads, all extras neutral.
function parityBaseParams(overrides) {
  return Object.assign({
    algorithm: 'hertzmann',
    brushRadii: [8, 4, 2],
    threshold: 50,
    maxStrokeLength: 16, minStrokeLength: 4,
    curvature: 1.0, opacity: 0.9, gridFactor: 1.0,
    satJitter: 0, sizeJitter: 0, brushTexture: 0,
    paletteSize: 0, bristleDensity: 0, textureTaper: 0,
    salienceOn: false, salienceStrength: 0, salienceCenter: 0, salienceDebug: false,
    neuralLevels: 4,
    dryBrushAmount: 0, tensorSigma: 0,
    hueJitter: 0, valJitter: 0, angleJitter: 0, opacityJitter: 0,
    impastoStrength: 0, impastoLightStrength: 0, lightAngle: 45,
    impastoProfile: 'flat', lightElevation: 0.5, specularStrength: 0,
    frameDiffThreshold: 0,
    maskData: null, maskWidth: 0, maskHeight: 0,
    fastPreview: false, underpaintMode: 'blur',
    orientationFill: false,
    etfRadius: 0, etfIterations: 2,
    // Pinned rather than defaulted: the relaxation configs below are meant to
    // exercise a multi-pass search regardless of what the shipped default is.
    relaxPasses: 2, relaxTrials: 2, relaxAreaWeight: 5,
    stipplePoints: 8000, stippleIters: 12, stippleDotMin: 1, stippleDotMax: 3, stippleInvert: false,
    strokeBatching: false, gpuAccel: false,
    seed: 1,
  }, overrides);
}

const PARITY_CONFIGS = [
  { name: 'hertzmann-plain',    params: parityBaseParams({}) },
  { name: 'hertzmann-texture',  params: parityBaseParams({ brushTexture: 0.5 }) },
  { name: 'hertzmann-jitters',  params: parityBaseParams({ sizeJitter: 0.3, opacityJitter: 0.3, angleJitter: 10, hueJitter: 0.05, satJitter: 0.2, valJitter: 0.2 }) },
  { name: 'hertzmann-drybrush', params: parityBaseParams({ dryBrushAmount: 0.5 }) },
  { name: 'hertzmann-impasto',  params: parityBaseParams({ impastoStrength: 0.6, impastoLightStrength: 0.6 }) },
  { name: 'hertzmann-imp-round',params: parityBaseParams({ impastoStrength: 0.6, impastoLightStrength: 0.6, impastoProfile: 'round', lightElevation: 0.25, specularStrength: 0.3 }) },
  { name: 'hertzmann-imp-brist',params: parityBaseParams({ impastoStrength: 0.6, impastoLightStrength: 0.6, impastoProfile: 'bristle', brushTexture: 0.5, specularStrength: 0.3 }) },
  { name: 'hertzmann-palette',  params: parityBaseParams({ paletteSize: 8 }) },
  { name: 'hertzmann-tensor',   params: parityBaseParams({ tensorSigma: 2 }) },
  // Layer-batched stroke growth: the semantics the GPU backend targets.
  // Deterministic in its own right, so it gets a baseline of its own.
  { name: 'hertzmann-batched',  params: parityBaseParams({ strokeBatching: true }) },
  { name: 'hertz-batch-jitter', params: parityBaseParams({ strokeBatching: true, sizeJitter: 0.3, opacityJitter: 0.3, angleJitter: 10, hueJitter: 0.05 }) },
  { name: 'relaxation-plain',   params: parityBaseParams({ algorithm: 'relaxation', underpaintMode: 'average' }) },
  { name: 'relaxation-tight',   params: parityBaseParams({ algorithm: 'relaxation', underpaintMode: 'none', relaxAreaWeight: 12, relaxPasses: 3, relaxTrials: 3 }) },
  { name: 'hertzmann-etf',      params: parityBaseParams({ etfRadius: 4, etfIterations: 2 }) },
  { name: 'litwinowicz-plain',  params: parityBaseParams({ algorithm: 'litwinowicz', brushRadii: [3] }) },
  { name: 'litwinowicz-texture',params: parityBaseParams({ algorithm: 'litwinowicz', brushRadii: [3], brushTexture: 0.5, tensorSigma: 2 }) },
  { name: 'litwinowicz-orient', params: parityBaseParams({ algorithm: 'litwinowicz', brushRadii: [3], orientationFill: true }) },
  { name: 'stipple-plain',      params: parityBaseParams({ algorithm: 'stipple', opacity: 1 }) },
  { name: 'stipple-noiters',    params: parityBaseParams({ algorithm: 'stipple', opacity: 1, stippleIters: 0, stipplePoints: 4000, stippleInvert: true }) },
];

// Committed reference hashes (seed 1). Regenerate with tools/parity-node.js
// and paste the output here whenever an intentional output change lands.
const PARITY_BASELINE = {
  'hertzmann-plain': '70d0810a',
  'hertzmann-texture': '86f30cde',
  'hertzmann-jitters': '75b91b65',
  'hertzmann-drybrush': '93312c8e',
  'hertzmann-impasto': '914effc5',
  'hertzmann-imp-round': 'c64cf417',
  'hertzmann-imp-brist': '5b6656a8',
  'hertzmann-palette': '7daf04ec',
  'hertzmann-tensor': '78ef3250',
  'hertzmann-batched': '6dbe9140',
  'hertz-batch-jitter': 'b4d80993',
  'relaxation-plain': '5e41311a',
  'relaxation-tight': '594af16f',
  'hertzmann-etf': '1c720d85',
  'litwinowicz-plain': 'b061f358',
  'litwinowicz-texture': 'cff8b905',
  'litwinowicz-orient': 'e2ffc783',
  'stipple-plain': 'dd49540b',
  'stipple-noiters': '6e186c5f',
};

// Allow require() from parity-node.js without breaking the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PARITY_W, PARITY_H, makeParityImage, parityHash, parityBaseParams, PARITY_CONFIGS, PARITY_BASELINE };
}
