'use strict';

// ─── Procedural brush textures ────────────────────────────────────────────────
// Precomputed alpha tiles that modulate stroke coverage so strokes read as
// bristled paint instead of flat capsules (SBR survey: physically-inspired
// stroke media, Vanderhaeghe & Collomosse 2012 §1.4).
//
// Tile space: u = position along the stroke (tiles horizontally, seamless),
// v = signed perpendicular offset / radius, -1..1 mapped to tile rows.
// Content = across-width bristle profile (seeded dips = gaps between bristles)
// × low-frequency along-stroke noise (dry/broken paint) × edge boost near the
// stroke border (pigment pooling). All tiles are generated with mulberry32 from
// fixed seeds, and the per-stroke variant is chosen by hashing the stroke seed
// position — never Math.random() — so video frames stay stable.

const BRUSH_TEX_W = 64;
const BRUSH_TEX_VARIANTS = 8;

// Integer hash of a stroke seed position + layer → deterministic variant pick.
function brushHash(x, y, layer) {
  let h = (x * 374761393 + y * 668265263 + layer * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function makeBrushTile(tw, th, density, rand) {
  // Across-width bristle profile: full coverage minus seeded gaussian dips.
  const profile = new Float32Array(th).fill(1);
  const nDips = Math.max(2, Math.round(density * th / 24));
  for (let k = 0; k < nDips; k++) {
    const c = rand() * th;
    const dw = 0.6 + rand() * 1.6;
    const depth = 0.3 + rand() * 0.55;
    for (let y = 0; y < th; y++) {
      const d = (y - c) / dw;
      profile[y] -= depth * Math.exp(-d * d);
    }
  }

  // Along-stroke value noise: cosine-interpolated control points, wrapped at
  // both ends so the tile repeats seamlessly along long strokes. Each row gets
  // its own phase so bristle streaks break up at different places.
  const ctrl = new Float32Array(9);
  for (let i = 0; i < 8; i++) ctrl[i] = rand();
  ctrl[8] = ctrl[0];
  const rowPhase = new Float32Array(th);
  for (let y = 0; y < th; y++) rowPhase[y] = rand() * tw;

  const tile = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const vAbs = Math.abs(th > 1 ? (y / (th - 1)) * 2 - 1 : 0);
    const edge = 1 + 0.22 * Math.max(0, (vAbs - 0.6) / 0.4);
    const p = Math.max(0.04, Math.min(1.15, profile[y])) * edge;
    for (let x = 0; x < tw; x++) {
      const fx = (((x + rowPhase[y]) % tw) / tw) * 8;
      const i0 = Math.floor(fx), f = fx - i0;
      const cf = (1 - Math.cos(f * Math.PI)) * 0.5;
      const n = ctrl[i0] * (1 - cf) + ctrl[i0 + 1] * cf;
      tile[y * tw + x] = Math.max(0, Math.min(1.2, p * (0.78 + 0.44 * n)));
    }
  }
  return tile;
}

// Build all tiles for a render job: one tile set per brush radius (tile height
// tracks stroke thickness) × BRUSH_TEX_VARIANTS variants. Cost is negligible
// (<1 ms), so calling this once per video frame inside paintify is fine.
function makeBrushTextures(radii, params) {
  const density = params.bristleDensity > 0 ? params.bristleDensity : 10;
  const taperAmt = Math.max(0, Math.min(1, params.textureTaper != null ? params.textureTaper : 0.4));

  // Taper LUT: effective-radius scale as a function of u (both stroke ends
  // shrink toward taperAmt-controlled tips; 1.0 through the body).
  const taperLUT = new Float32Array(BRUSH_TEX_W);
  const endFrac = 0.06 + 0.30 * taperAmt;
  for (let i = 0; i < BRUSH_TEX_W; i++) {
    const u = i / (BRUSH_TEX_W - 1);
    const e = Math.min(u, 1 - u);
    let s = taperAmt <= 0 ? 1 : Math.min(1, e / endFrac);
    s = s * s * (3 - 2 * s);
    taperLUT[i] = (1 - 0.45 * taperAmt) + 0.45 * taperAmt * s;
  }

  const perRadius = radii.map((r, ri) => {
    const th = Math.max(8, Math.min(48, Math.round(2 * Math.max(1, r))));
    const tiles = [];
    for (let v = 0; v < BRUSH_TEX_VARIANTS; v++) {
      tiles.push(makeBrushTile(BRUSH_TEX_W, th, density, mulberry32(0x9E3779B9 ^ (ri * 131 + v * 7919))));
    }
    return { tiles, th };
  });

  return {
    perRadius, taperLUT,
    tw: BRUSH_TEX_W,
    variants: BRUSH_TEX_VARIANTS,
    strength: Math.max(0, Math.min(1, params.brushTexture || 0)),
  };
}

// Per-stroke texture handle: deterministic variant + u-phase from the stroke
// seed position. renderStrokeSolid fills in uScale/arc bookkeeping.
function getStrokeTexture(bt, radiusIndex, seedX, seedY) {
  if (!bt) return null;
  const pr = bt.perRadius[Math.min(radiusIndex, bt.perRadius.length - 1)];
  const h = brushHash(Math.round(seedX) | 0, Math.round(seedY) | 0, radiusIndex);
  return {
    tile: pr.tiles[h % bt.variants],
    tw: bt.tw, th: pr.th,
    uOff: (h >>> 3) % bt.tw,
    strength: bt.strength,
    taperLUT: bt.taperLUT,
  };
}
