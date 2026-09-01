# Painterly Image Creator Web

Browser-based stroke-painting renderer implementing seven stroke-based NPR algorithms (Hertzmann 1998 curved strokes, Litwinowicz 1997 impressionist strokes, Haeberli 1990 paint-by-numbers, Shiraishi–Yamaguchi 2000 moment-fitted strokes, Secord 2002 weighted Voronoi stippling, a colored pencil hatching style, and the neural Paint Transformer, ICCV 2021). Runs entirely client-side — no server, no build step.

## Architecture

Plain JavaScript at the repo root:

| File | Role |
|---|---|
| `index.html` | All markup: sidebar controls, canvas area, mode tabs |
| `styles.css` | All styles |
| `main.js` | UI state, event wiring, preset management, worker orchestration |
| `worker.js` | Off-thread painting algorithms (Web Worker) |
| `brush-texture.js` | Procedural bristle texture tiles (loaded by worker.js via `importScripts`) |
| `styles/shiraishi.js` | Shiraishi–Yamaguchi 2000 algorithm (loaded by worker.js via `importScripts`) |
| `styles/stipple.js` | Secord 2002 weighted Voronoi stippling (loaded by worker.js via `importScripts`) |
| `neural.js` | Paint Transformer pipeline (lazy-loaded by worker.js only for the neural algorithm) |
| `vendor/ort/ort.min.js` | onnxruntime-web UMD bundle (lazy-loaded with neural.js; see `vendor/ort/VERSION.md`) |
| `video-batch.js` | `PainterWorker` wrapper class, `ZipWriter`, video/batch processors |
| `webm-muxer.js` | Third-party WebM muxer (bundled, do not edit) |
| `gpu/gpu-hertzmann.js` | WebGL2 backend for Hertzmann (lazy-loaded by worker.js; maps + rasterizer) |
| `tools/` | Offline Python tooling (ONNX conversion + CDN upload) and the determinism/parity harness (`parity.html`, `parity-common.js`, `parity-node.js`) — not served |

The algorithm runs entirely inside `worker.js` to keep the UI thread free. `main.js` spawns the worker, posts `render` messages, and receives `progress`/`status`/`done`/`error` responses. `video-batch.js` wraps the worker in a `PainterWorker` class and handles multi-frame pipelines.

## Algorithms (worker.js)

`paintify()` is a thin driver: downscale (fast preview), RGBA→Float32 RGB, palette build, then dispatch through the `ALGORITHMS` registry keyed by `params.algorithm` (fallback: `hertzmann`):

| Key | Function | Approach |
|---|---|---|
| `hertzmann` | `paintHertzmann` | Layered coarse→fine curved strokes; Lab error map decides where to repaint; strokes follow gradient perpendiculars (`makeCurvedStroke`). Only algorithm that supports temporal coherence (`prevState`) and the detail mask. |
| `litwinowicz` | `paintLitwinowicz` | Jittered grid of short oriented strokes (⊥ smoothed gradient via structure tensor), clipped where Sobel edge magnitude exceeds 0.35·max. Optional `orientationFill` interpolates stroke angles across weak-gradient areas via a push-pull pyramid on the doubled-angle field (default off = legacy constant 45° fallback; deviation: push-pull instead of the paper's thin-plate interpolation). |
| `haeberli` | `paintHaeberli` | Random seeded daubs, one pass per radius coarse→fine; round dab or gradient-oriented daub. Optional `haeberliSizeByGradient` shrinks dabs near strong edges (paper's size-by-local-detail). |
| `shiraishi` | `paintShiraishi` (styles/shiraishi.js) | Shiraishi–Yamaguchi 2000: per layer, stroke seeds by Floyd–Steinberg dithering of an importance image (uniform, then canvas-vs-source Lab error), each stroke fitted from second-order moments of a local color-similarity image (equivalent-rectangle center/angle/length/width). Deviations: capsules instead of sharp rectangles; colors from the layer-blurred source. |
| `stipple` | `paintStipple` (styles/stipple.js) | Secord 2002 weighted Voronoi stippling: luminance-derived density on a ≤512px grid, seeded rejection-sampled sites, Lloyd relaxation with jump-flooding nearest-site assignment (ties → lower id, deterministic), dots emitted via the sink's `dot` fast path. Always starts from white; ignores `underpaintMode`. |
| `pencil` | `paintPencil` | White paper, luminance-gated colored hatch strokes (+cross-hatch in shadows), edge-emphasis pass, deterministic paper-grain multiply. Ignores `underpaintMode`. |
| `neural` | `paintNeural` (neural.js) | Paint Transformer: coarse→fine patch pyramid, batched ONNX inference (WebGPU→wasm fallback), strokes decoded to oriented capsules and rasterized through `renderStrokeSolid` at full resolution. Async — `paintify` awaits it. Registered lazily by `ensureNeural()` so classic modes never load onnxruntime. Model + ORT wasm live on the CDN (see `vendor/ort/VERSION.md`), cached via the browser Cache API. |

Shared helpers: `applyUnderpaint(env)`, `applyImpastoLighting(env)`, `finalizeStrokeColor()` (palette snap → HSV jitter), `renderStrokeSolid()` (capsule rasterizer — stroke points may be fractional; the mask bounding box is floor/ceil'd to stay integral, do not regress this; optional trailing `tex` handle switches to the textured inner loop), `computeSalience`/`buildDetailMap` (unified detail map: manual mask ∪ salience, `env.detailMap`, null when off), `gaussianBlurRGB`, `computeGradients`, `computeGradientsST`, `rgbToLab`.

Brush textures (`brush-texture.js`): `makeBrushTextures` builds seeded per-radius tile sets once per job (only when `params.brushTexture > 0`); `getStrokeTexture` hashes the stroke seed position for a deterministic variant. Strength 0 must remain byte-identical to the untextured path — regression-tested against committed output.

RNG & determinism: every algorithm is seeded — same `params.seed` + same params ⇒ byte-identical output. Each algorithm creates one `mulberry32(CONSTANT ^ (params.seed | 0))` per render and threads it through every random draw (including `finalizeStrokeColor`'s jitters — never let it fall back to its `Math.random` default). Seeds are stable **within** a version only: adding or reordering any RNG draw silently changes fixed-seed output — when that happens intentionally, regenerate the parity baselines (below). Fixed constants per algorithm: hertzmann `0x1E52A11`, litwinowicz `0xC0FFEE`, haeberli `0xBADA55`, pencil `0x9E3779B9`, shiraishi `0x51DA15`, stipple `0x577DD1E`, neural color jitter `0x7A1D7E`.

**Stroke sink**: generation and rasterization are decoupled. Style generators build a `StrokeRecord` — `{ pts, radius, color (final), opacity, layer, tex, dryBrush, height, dot?, styleData? }` (documented above `makeCanvasSink` in worker.js) — and call `env.sink.emit(record)`. The default canvas sink rasterizes immediately through `renderStrokeSolid` (generators must emit in paint order: stroke growth and error maps read the live canvas), with a `dot: true` allocation-free disc fast path for stippling. New styles must route all drawing through the sink, never call `renderStrokeSolid` directly.

**Impasto** (Hertzmann 2002): `params.impastoProfile` selects the height model — `'flat'` (legacy: heightBuf accumulates stroke coverage), `'round'` (per-stroke height dome composited like paint: ridge along the spine, falloff to edges), `'bristle'` (dome × brush-tile grooves, needs brushTexture > 0 to differ from round). `applyImpastoLighting` takes `lightAngle`, `lightElevation` (0.5 = legacy default), and `specularStrength` (Blinn-Phong sheen; flat-surface specular is subtracted so flat regions stay untouched, matching the diffuse neutral-flat convention).

The `env` object passed to each algorithm: `{ srcRGB, canvasRGB, w, h, radii, params, palette, heightBuf, onProgress, brushTex, detailMap, onStatus, prevState, sink }`.

**GPU acceleration** (`params.gpuAccel`, Hertzmann only): profiling showed the algorithm is ~88% per-pixel map math plus rasterization and only ~1% stroke growth (the part that reads the live canvas), so `gpu/gpu-hertzmann.js` moves blur, sRGB→Lab, the Lab error map, Sobel gradients, the underpainting blur and stroke rasterization to WebGL2, keeping the canvas resident in a texture across layers. Stroke *generation* stays on the CPU because it consumes the seeded RNG in a fixed order. Measured 3.4–4.4× end to end on an M1; see `tools/gpu-hertzmann-RESULTS.md` and the harness `tools/gpu-bench.html`.

Invariants worth not regressing: textures are uploaded row 0 = image row 0 and every pass addresses them with unflipped `gl_FragCoord`/`texelFetch` — flipping only the stroke pass mirrors strokes about the image centre (the centre row still matches, so it spot-checks as correct). The rasterizer draws **one instance per stroke** taking the min distance over the whole polyline, matching the CPU's max-coverage-into-one-mask semantics; one capsule per segment double-blends at joints. `refBlur.rgb` + error map share one RGBA32F target because readback, not shading, dominates. Anything the GPU rasterizer does not implement (brush texture, dry-brush, impasto relief) falls back to the CPU rasterizer per layer; `tensorSigma > 0` falls back to CPU maps.

**Stroke batching** (`params.strokeBatching`, Hertzmann only): grows a layer's strokes against the canvas as it was at the *start* of the layer, then emits them together — which is what Hertzmann's pseudocode does (paintLayer collects into a set S and paints S after the cell loop). It is the precondition for GPU rasterization and is implied by `gpuAccel`. RNG draw order is unchanged, so it is deterministic and separately baselined (`hertzmann-batched`, `hertz-batch-jitter`).

**Parity harness** (`tools/`): `node tools/parity-node.js` renders every algorithm × feature config three times (seed 1×2, seed 2) and checks determinism, seed sensitivity, and the committed `PARITY_BASELINE` hashes in `tools/parity-common.js`; `tools/parity.html` is the in-browser equivalent (serve the repo root, open `/tools/parity.html`). Run it after any change to worker.js, brush-texture.js, or styles/; if an output change is intentional, regenerate with `node tools/parity-node.js --baseline` and paste the result into `parity-common.js`.

Offline tooling: `tools/convert_paint_transformer.py` (PyTorch → ONNX fp16 with torch-vs-ORT parity self-check; needs `torch onnx onnxruntime onnxconverter-common`), `tools/upload_neural_assets.py` (uploads model + ORT wasm to B2 under `painterly/`; reads `B2_KEY_ID`/`B2_APP_KEY` env vars).

## Modes

- **Image** — single photo → painted PNG download.
- **Video** — video file → painted `.webm` (VP8 via WebCodecs on Chrome/Edge) or ZIP of PNG frames (Firefox/Safari).
- **Batch** — multiple images → save to a chosen folder (Chrome/Edge File System Access API) or ZIP download.

All modes share the same sidebar parameters.

## Parameters & UI conventions

- Normal controls (sliders): brush radii, max/min stroke length, curvature, threshold T, grid factor, opacity, saturation jitter, size jitter, brush texture, underpainting, fast preview.
- **Experimental controls** live in `#experimental-fields` (always visible — no toggle) as `<select>` dropdowns, each with a neutral default option (usually "Off"): hue/value/angle/opacity jitter, palette size, dry-brush, direction smoothing (tensor σ), impasto strength/light, light angle, bristle density, stroke taper, salience center bias. Option `value`s are the raw numeric params, so `getParams()` reads them with `parseFloat`/`parseInt` like any control — no gating. `setSlider()` snaps a preset's continuous value to the nearest option. When adding an experimental control, make it a `<select>` whose default option is neutral so a hidden control can't affect the result.
- **Per-stroke non-uniformity** (Hertzmann only): `sizeJitter` (radius) and `opacityJitter` are applied per stroke in `paintHertzmann`; `angleJitter` (degrees) rotates each step inside `makeCurvedStroke`. All draw from the per-render seeded RNG.
- **Seed**: `#seed` number input (default 0) — same seed + same settings reproduces the same painting in every algorithm; it stays fixed across video/batch frames (frame-to-frame stability).
- **Per-algorithm visibility**: elements carry `data-algos="hertzmann litwinowicz …"`; `updateControlVisibility()` in `main.js` shows/hides them on algorithm change and preset apply. When adding a control, give it a `data-algos` attribute and a `.tip` tooltip span.
- **Tooltips**: `<span class="tip" tabindex="0" data-tip="…">i</span>` next to each label; a single fixed-position `#tooltip` element (created in `main.js`) is positioned beside the hovered/focused icon — CSS-only tooltips would clip in the scrolling sidebar.
- **Typography**: follows the Astryx design system font roles — Figtree for both body (`--font-ui`) and headings (`--font-display`, semibold 600 on the 14px × 1.2 geometric scale), Lilex (`--font-mono`) for numeric values.

## Presets

Defined in `main.js` as the `PRESETS` object: `impressionist`, `expressionist`, `pointillist`, `wash` (Hertzmann), `litstrokes` (Litwinowicz, opts into `orientationFill`), `daubs` (Haeberli), `patchwork` (Shiraishi), `stippled` (stipple), `pencilsketch` (pencil). Every preset carries an `algorithm` field; `applyPreset` merges over `PRESET_DEFAULTS` so omitted fields reset rather than leak from the previous preset. When adding a preset, add it to `PRESETS` and a matching `<option>` inside the right `<optgroup>` in `index.html`.

## Development

No build step. Serve the repo root with any static server:

```
npx serve .
```

Or open `index.html` directly (some browser security restrictions may apply for local `Worker` scripts — use a server to be safe).

**Cloudflare Pages:** connect the repo, set build output directory to `/`, leave build command blank.

## Browser Compatibility

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Image rendering | Yes | Yes | Yes |
| Video → WebM | Yes (WebCodecs) | ZIP fallback | ZIP fallback |
| Batch → folder | Yes (File System Access) | ZIP fallback | ZIP fallback |

The feature-detect for WebCodecs is in `video-batch.js`; ZIP fallback uses the inline `ZipWriter` class.

## Key Constraints

- **No dependencies to install** — `webm-muxer.js` is bundled. Do not introduce a package manager or build tool unless specifically asked.
- **No modules** — all files use `'use strict'` with globals, not ES modules, because `Worker` scripts loaded as modules require additional flags in some browsers.
- **Algorithm fidelity** — the goal is a faithful web port of the Hertzmann 1998 paper. Algorithmic changes should cite or note where they deviate from the paper.
