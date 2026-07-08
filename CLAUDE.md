# Painterly Image Creator Web

Browser-based stroke-painting renderer implementing four stroke-based NPR algorithms (Hertzmann 1998 curved strokes, Litwinowicz 1997 impressionist strokes, Haeberli 1990 paint-by-numbers, and a colored pencil hatching style). Runs entirely client-side — no server, no build step.

## Architecture

Six files at the repo root, all plain JavaScript:

| File | Role |
|---|---|
| `index.html` | All markup: sidebar controls, canvas area, mode tabs |
| `styles.css` | All styles |
| `main.js` | UI state, event wiring, preset management, worker orchestration |
| `worker.js` | Off-thread painting algorithm (Web Worker) |
| `video-batch.js` | `PainterWorker` wrapper class, `ZipWriter`, video/batch processors |
| `webm-muxer.js` | Third-party WebM muxer (bundled, do not edit) |

The algorithm runs entirely inside `worker.js` to keep the UI thread free. `main.js` spawns the worker, posts `render` messages, and receives `progress`/`done`/`error` responses. `video-batch.js` wraps the worker in a `PainterWorker` class and handles multi-frame pipelines.

## Algorithms (worker.js)

`paintify()` is a thin driver: downscale (fast preview), RGBA→Float32 RGB, palette build, then dispatch through the `ALGORITHMS` registry keyed by `params.algorithm` (fallback: `hertzmann`):

| Key | Function | Approach |
|---|---|---|
| `hertzmann` | `paintHertzmann` | Layered coarse→fine curved strokes; Lab error map decides where to repaint; strokes follow gradient perpendiculars (`makeCurvedStroke`). Only algorithm that supports temporal coherence (`prevState`) and the detail mask. |
| `litwinowicz` | `paintLitwinowicz` | Jittered grid of short oriented strokes (⊥ smoothed gradient via structure tensor), clipped where Sobel edge magnitude exceeds 0.35·max. |
| `haeberli` | `paintHaeberli` | Random seeded daubs, one pass per radius coarse→fine; round dab or gradient-oriented daub. |
| `pencil` | `paintPencil` | White paper, luminance-gated colored hatch strokes (+cross-hatch in shadows), edge-emphasis pass, deterministic paper-grain multiply. Ignores `underpaintMode`. |

Shared helpers: `applyUnderpaint(env)`, `applyImpastoLighting(env)`, `finalizeStrokeColor()` (palette snap → HSV jitter), `renderStrokeSolid()` (capsule rasterizer — stroke points may be fractional; the mask bounding box is floor/ceil'd to stay integral, do not regress this), `gaussianBlurRGB`, `computeGradients`, `computeGradientsST`, `rgbToLab`.

RNG: Hertzmann uses `Math.random()`; the other three use seeded `mulberry32` so stroke placement is deterministic (video frame stability).

The `env` object passed to each algorithm: `{ srcRGB, canvasRGB, w, h, radii, params, palette, heightBuf, onProgress, prevState }`.

## Modes

- **Image** — single photo → painted PNG download.
- **Video** — video file → painted `.webm` (VP8 via WebCodecs on Chrome/Edge) or ZIP of PNG frames (Firefox/Safari).
- **Batch** — multiple images → save to a chosen folder (Chrome/Edge File System Access API) or ZIP download.

All modes share the same sidebar parameters.

## Parameters & UI conventions

- Normal controls: brush radii, max/min stroke length, curvature, threshold T, grid factor, opacity, saturation jitter, underpainting, fast preview.
- **Experimental controls** (hue/value jitter, palette size, dry-brush, tensor σ, impasto strength/light/angle) live in `#experimental-fields` behind the `#experimental-toggle` checkbox. Gating happens in `getParams()` in `main.js`: when the toggle is off these params are sent as neutral values regardless of slider state. Never bypass this by reading sliders directly.
- **Per-algorithm visibility**: elements carry `data-algos="hertzmann litwinowicz …"`; `updateControlVisibility()` in `main.js` shows/hides them on algorithm change, preset apply, and toggle change. When adding a control, give it a `data-algos` attribute and a `.tip` tooltip span.
- **Tooltips**: `<span class="tip" tabindex="0" data-tip="…">i</span>` next to each label; a single fixed-position `#tooltip` element (created in `main.js`) is positioned beside the hovered/focused icon — CSS-only tooltips would clip in the scrolling sidebar.
- **Typography**: follows the Astryx design system font roles — Figtree for both body (`--font-ui`) and headings (`--font-display`, semibold 600 on the 14px × 1.2 geometric scale), Lilex (`--font-mono`) for numeric values.

## Presets

Defined in `main.js` as the `PRESETS` object: `impressionist`, `expressionist`, `pointillist`, `wash` (Hertzmann), `litstrokes` (Litwinowicz), `daubs` (Haeberli), `pencilsketch` (pencil). Every preset carries an `algorithm` field; `applyPreset` merges over `PRESET_DEFAULTS` so omitted fields reset rather than leak from the previous preset. When adding a preset, add it to `PRESETS` and a matching `<option>` inside the right `<optgroup>` in `index.html`.

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
