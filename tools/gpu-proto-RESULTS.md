# GPU rasterizer prototype — results & recommendation

> **Superseded in part.** Recommendation 3 below ("Keep Hertzmann on CPU") was
> based on this rasterizer-only benchmark. Profiling the whole algorithm showed
> rasterization is only ~21% of it, while the per-pixel maps are ~67% and the
> live-canvas stroke growth just ~1% — so Hertzmann *was* worth porting, and now
> runs 3.4–4.4× faster on the GPU. See `gpu-hertzmann-RESULTS.md`.

Decision spike for "is a GPU version worth building?" Measured a WebGL2
instanced-capsule rasterizer against the CPU `renderStrokeSolid` path on the
*same* captured stroke lists. Run it yourself: serve the repo root and open
`/tools/gpu-proto.html` (the numbers below are from an **Apple M1, ANGLE Metal**;
click Run on your own hardware for local figures).

## Numbers (M1, ANGLE Metal)

| Style | Size | Strokes | Instances | CPU raster | GPU draw | GPU readback | mean Δ | max Δ |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| hertzmann | 320×240 | 1,607 | 6,048 | 139 ms | <0.05 ms | 24 ms | 1.10 | 166 |
| hertzmann | 1280×720 | 15,956 | 50,700 | 1,270 ms | <0.05 ms | 43 ms | 0.43 | 193 |
| hertzmann | 1920×1080 | 34,987 | 103,613 | 2,150 ms | <0.05 ms | 113 ms | 0.32 | 193 |
| haeberli | 320×240 | 6,300 | 6,300 | 103 ms | <0.05 ms | 22 ms | 0.07 | 133 |
| haeberli | 1280×720 | 75,600 | 75,600 | 760 ms | <0.05 ms | 49 ms | 0.04 | 127 |
| haeberli | 1920×1080 | 170,100 | 170,100 | 1,671 ms | <0.05 ms | 156 ms | 0.03 | 167 |
| stipple | 320×240 | 20,000 | 20,000 | 42 ms | <0.05 ms | 7 ms | 7.0 | 167 |
| stipple | 1280×720 | 20,000 | 20,000 | 56 ms | <0.05 ms | 10 ms | 24.2 | 167 |
| stipple | 1920×1080 | 20,000 | 20,000 | 53 ms | <0.05 ms | 14 ms | 12.5 | 167 |

Δ = per-channel abs difference (0–255) vs the CPU output. CPU and GPU output
hashes differ in **every** case.

## Speed

GPU draw dispatch is sub-millisecond and asynchronous — too fast to time even
averaged over 8 repeats — while CPU rasterization is **90 ms – 2.1 s**, scaling
with stroke count × area. The only substantial GPU-side cost measured is
`readPixels` (7–156 ms), and that exists **only because the benchmark copies
pixels back to CPU to diff them**. Real display/interactive rendering needs zero
readback, and video export would hand the GL texture to WebCodecs once (or encode
GPU-side). Net: **1–2 orders of magnitude faster, gap widening with resolution
and stroke count.** This is the strongest argument for GPU, and it targets the
project's actual goal (video).

## Fidelity & determinism

Interiors are pixel-identical; differences live entirely on anti-aliased **edges**
where GPU `highp` float rounds coverage (`r − dist + 0.5`) across its threshold
differently than JS doubles, flipping isolated boundary pixels. Consequences:

- Stroke styles (hertzmann, haeberli) are **visually indistinguishable** —
  mean Δ 0.03–1.1, differences confined to ~1px stroke outlines.
- **The smaller the primitive, the worse the gap.** Stipple dots (radius 1–3)
  are all-edge, so mean Δ climbs to 7–24 — the worst case.
- **GPU cannot reproduce CPU output bit-for-bit** (hashes always differ), and it
  varies by GPU/driver/precision. This directly ends the exact-determinism and
  frame-to-frame parity the CPU path + parity harness provide.

## Recommendation

The data supports the **incremental GPU track, not a full rewrite:**

1. GPU as a **post-pass** (display relighting of the impasto height field,
   finish effects) — zero fidelity risk, keeps the parity harness green, and the
   plumbing is a subset of what this prototype already proves works.
2. GPU **stroke rasterizer as an opt-in backend** for the parallel-friendly
   styles (Litwinowicz / Haeberli / Shiraishi / stipple), keeping the CPU path
   as the deterministic reference. Accept that GPU output is
   visually-equal-but-not-identical; it's a *mode*, not a replacement.
3. Keep **Hertzmann on CPU** (its stroke growth reads the live canvas — a poor
   GPU fit) and keep the parity harness authoritative on the CPU path.

A full GPU-everything replacement would trade away the determinism/parity/video-
stability just built for speed that the incremental path mostly captures anyway.

## Prototype scope (what these numbers do / don't cover)

Solid strokes only. Excludes textured/dry-brush/impasto GPU rasterization, a GPU
port of Hertzmann *generation* (only its captured strokes are rastered here), and
WebGPU. The one production change is an inert `params.captureStrokes` hook in
`worker.js` (parity harness unaffected — still all-MATCH).
