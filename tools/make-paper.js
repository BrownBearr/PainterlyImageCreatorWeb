'use strict';

// Generates assets/paper.png — the bundled, seamlessly tileable paper texture
// composited under every painting by worker.js's applyPaperTexture().
//
// Run once and commit the result; the app never runs this. No dependencies:
// the PNG is encoded here with Node's built-in zlib.
//
//   node tools/make-paper.js
//
// The texture is warm off-white cold-press stock: fractal mottle for the pulp,
// crossed low-contrast streaks for the fibers, and a few darker flecks. All
// noise is lattice-periodic so the image tiles without a visible seam.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SEED = 7;

// ─── Periodic value noise ─────────────────────────────────────────────────────
// perX/perY are the lattice periods in cells. Each axis must wrap by its own
// cell count — the fiber layers are deliberately anisotropic (e.g. 3×48), so a
// single shared period would leave one edge unwrapped and produce a seam.

function hash2(xi, yi, s, perX, perY) {
  xi = ((xi % perX) + perX) % perX;
  yi = ((yi % perY) + perY) % perY;
  const n = Math.sin(xi * 127.1 + yi * 311.7 + s * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function vnoise(x, y, s, perX, perY) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
  const a = hash2(xi, yi, s, perX, perY), b = hash2(xi + 1, yi, s, perX, perY);
  const c = hash2(xi, yi + 1, s, perX, perY), d = hash2(xi + 1, yi + 1, s, perX, perY);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Octave sum in [0,1]; cell counts double per octave so the period doubles too.
function fbm(u, v, s, cellsX, cellsY, octaves) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = cellsX * (1 << o), cy = cellsY * (1 << o);
    sum += amp * vnoise(u * cx, v * cy, s + o * 31, cx, cy);
    norm += amp;
    amp *= 0.5;
  }
  return norm > 0 ? sum / norm : 0.5;
}

// ─── PNG encoding (8-bit RGB, no interlace) ───────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgb, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate / adaptive / no interlace

  // Filter type 0 (None) on every scanline — the texture compresses fine and
  // this keeps the encoder trivially verifiable.
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0;
    rgb.copy(raw, o + 1, y * w * 3, (y + 1) * w * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Texture ──────────────────────────────────────────────────────────────────

function makePaper(size) {
  // Warm cold-press cream. Kept light: applyPaperTexture multiplies by this,
  // so a bright base means even "Strong" tints rather than muddies the paint.
  const BASE = [247, 243, 234];
  const rgb = Buffer.alloc(size * size * 3);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Pulp mottle: broad clouding across the sheet.
      const mottle = fbm(u, v, SEED, 6, 6, 5) - 0.5;

      // Fibers: two crossed sets of stretched streaks, low contrast.
      const fiberH = fbm(u, v, SEED + 101, 3, 48, 3) - 0.5;
      const fiberV = fbm(u, v, SEED + 211, 48, 3, 3) - 0.5;

      // Tooth: fine high-frequency grain, the cold-press bite.
      const tooth = fbm(u, v, SEED + 307, 64, 64, 2) - 0.5;

      // Flecks: rare dark specks of unbleached pulp.
      const speckN = vnoise(u * 96, v * 96, SEED + 401, 96, 96);
      const speck = speckN > 0.93 ? -(speckN - 0.93) * 2.2 : 0;

      const shade = 1
        + mottle * 0.055
        + (fiberH + fiberV) * 0.030
        + tooth * 0.022
        + speck;

      const f = Math.max(0.80, Math.min(1.03, shade));
      const i = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        rgb[i + c] = Math.max(0, Math.min(255, Math.round(BASE[c] * f)));
      }
    }
  }
  return rgb;
}

const out = path.join(__dirname, '..', 'assets', 'paper.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
const rgb = makePaper(SIZE);
fs.writeFileSync(out, encodePNG(rgb, SIZE, SIZE));

// Report the range so a regenerated texture can be sanity-checked at a glance.
let min = 255, max = 0, sum = 0;
for (let i = 0; i < rgb.length; i += 3) {
  if (rgb[i] < min) min = rgb[i];
  if (rgb[i] > max) max = rgb[i];
  sum += rgb[i];
}
console.log(`wrote ${out} (${SIZE}×${SIZE}, R min ${min} max ${max} mean ${(sum / (rgb.length / 3)).toFixed(1)})`);
