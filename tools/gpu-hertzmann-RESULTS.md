# GPU-accelerated Hertzmann — results

Supersedes recommendation 3 of `gpu-proto-RESULTS.md` ("Keep Hertzmann on CPU").
That conclusion was drawn from a rasterizer-only benchmark. Profiling the *whole*
algorithm changes the picture.

Reproduce: serve the repo root and open `/tools/gpu-bench.html`, or run the
in-app toggle (Experimental → GPU acceleration).

## Where the time actually goes

Per-phase profile of `paintHertzmann`, default params, CPU path:

| size | total | Lab | blur | raster | grad | cellpick | **grow** | errmap |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 320×240 | 165 ms | 31% | 23% | 21% | 13% | 4% | **2%** | 1% |
| 1280×720 | 1606 ms | 34% | 22% | 19% | 7% | 7% | **1%** | 1% |
| 1920×1080 | 3183 ms | 34% | 25% | 21% | 7% | 7% | **1%** | 1% |

The part assumed to block a GPU port — stroke growth reading the live canvas —
is **1% of runtime**. The Lab conversion alone is a third. About 88% of the
algorithm is per-pixel map math plus rasterization, both ideal GPU work.

## What the backend does

`gpu/gpu-hertzmann.js` (WebGL2, `OffscreenCanvas`, `EXT_color_buffer_float`)
moves to the GPU, with the canvas resident in a texture across layers:

- separable Gaussian blur, sRGB→Lab, Lab error map, Sobel gradients
- the underpainting blur (it is the same Gaussian layer 0 computes anyway)
- stroke rasterization, one instance per stroke

Stroke *generation* stays on the CPU: it is 8% of runtime and it consumes the
seeded RNG stream in a fixed order, which is what keeps the mode reproducible.

Two things mattered more than expected:

- **Readback dominates.** At 1080p the five shader passes cost ~10 ms while the
  readbacks cost ~45 ms. Packing `refBlur.rgb` and the error map into one RGBA32F
  target (error in alpha) removed a whole `readPixels` per layer.
- **One instance per stroke, not per segment.** The CPU takes *max* coverage over
  a stroke's segments into a single mask and composites that once. Drawing a
  capsule per segment (as `gpu-proto.js` does) double-blends at the joints. The
  fragment shader instead takes the minimum distance over the whole polyline.

## Measured — Apple M1, ANGLE Metal, Chromium

| size | CPU (batched) | GPU | speedup | mean Δ |
|---|--:|--:|--:|--:|
| 640×480 | 488 ms | 127 ms | **3.84×** | 0.00 |
| 1280×720 | 1465 ms | 335 ms | **4.38×** | 0.00 |
| 1920×1080 | 3289 ms | 957 ms | **3.44×** | 0.00 |

Per-pass agreement against the CPU functions (256×192, σ=4), via headless
Chromium/SwiftShader — same GLSL through the same ANGLE translator:

| pass | mean Δ | max Δ |
|---|--:|--:|
| Gaussian blur | 8.9e-6 | 7.6e-5 |
| Sobel gx / gy / \|g\| | ~1.4e-7 | ~9e-7 |
| Lab error map | 1.9e-5 | 1.2e-4 |

Fallback paths (400×300), GPU vs batched CPU:

| config | what falls back | mean Δ | max Δ | speedup |
|---|---|--:|--:|--:|
| brush texture 0.5 | CPU rasterizer, GPU maps | 0.000 | 1 | 1.6× |
| impasto 0.5 | CPU rasterizer, GPU maps | 0.008 | 33 | 1.7× |
| tensorSigma 2 | CPU maps, GPU rasterizer | 1.390 | 76 | 1.0× |
| underpaint "none" | CPU underpaint only | 0.000 | 1 | 2.7× |

`tensorSigma > 0` has no GPU structure-tensor pass, so it keeps the CPU maps and
sees no benefit — the honest result, not a rounding artefact.

## Fidelity

GPU output is **not** bit-identical to the CPU path and cannot be: float rounding
differs by driver. It is compared against the *batched* CPU path
(`strokeBatching`), which is its exact semantic reference and is parity-baselined
in `tools/parity-common.js`.

Once the underpainting moved to the GPU, agreement became near-exact
(mean Δ 0.004, 0.1% of channels differing at 320×240) because the underpaint and
layer 0's reference blur then come from the *same* GPU Gaussian, so the two paths
stop disagreeing about which cells cross the error threshold. Before that change
the same comparison was mean Δ 2.41 with 55% of channels differing.

## A bug worth recording

The first working version was wrong in a way that is easy to miss. The stroke
vertex shader flipped Y (`-clip.y`, inherited from `gpu-proto.js`, which
presented to the default framebuffer) while every other pass addressed textures
with unflipped `gl_FragCoord`/`texelFetch`. Strokes landed **mirrored about the
horizontal centre line**, which corrupted the next layer's error map and drove
the stroke count from 1,213 to 14,547.

What made it sneaky: the image centre row is the mirror's fixed point, so
spot-checking the middle pixel showed an *exact* match while the corners were
completely wrong.

## Not done

- **GPU cell reduction.** `chooseBestInCell` is ~7% and draws from the seeded RNG
  once per pixel; moving it would break RNG-order equivalence with the CPU path.
- **GPU stroke growth.** Only 1% of runtime, but doing it would remove the
  per-layer readback entirely — which is the real remaining cost.
- WebGPU compute, and GPU paths for the structure tensor, brush textures,
  dry-brush and impasto relief.
