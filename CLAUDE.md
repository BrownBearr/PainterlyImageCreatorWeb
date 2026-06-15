# Painterly Image Creator Web

Browser-based stroke-painting renderer based on Aaron Hertzmann's *Painterly Rendering with Curved Brush Strokes of Multiple Sizes* (1998). Runs entirely client-side — no server, no build step.

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

## Algorithm (worker.js)

Implements the Hertzmann 1998 multi-layer approach:

1. Fill canvas with underpainting (blurred image, average colour, or white).
2. For each brush radius (coarse → fine):
   - Gaussian-blur the reference image to the current scale.
   - Compute a per-pixel Lab-colour error map between the blurred reference and the current canvas.
   - Walk a shuffled grid; wherever cell error exceeds threshold `T`, grow a curved stroke following the image gradient.
   - Stop the stroke when it diverges from the reference or reaches max length.
3. Finer layers fill detail missed by coarser strokes.

Key internals:
- `makeRng` / `shuffleArray` — seeded mulberry32 RNG for reproducible outputs.
- `gaussianBlurRGB` — separable Gaussian blur in float RGB.
- `rgbToLab` — sRGB → CIE Lab for perceptual error measurement.
- Strokes are solid anti-aliased rounded rectangles (or texture-stamped if a brush texture is loaded).

## Modes

- **Image** — single photo → painted PNG download.
- **Video** — video file → painted `.webm` (VP8 via WebCodecs on Chrome/Edge) or ZIP of PNG frames (Firefox/Safari).
- **Batch** — multiple images → save to a chosen folder (Chrome/Edge File System Access API) or ZIP download.

All modes share the same sidebar parameters.

## Parameters

| Parameter | Default | Effect |
|---|---|---|
| Brush radii | `8, 4, 2` | Comma-separated layer radii, coarse → fine |
| Max stroke length | 16 | Steps before a stroke is forced to stop |
| Min stroke length | 4 | Steps before early-stop is allowed |
| Curvature | 1.0 | 0 = straight strokes, 1 = follows image edges |
| Error threshold T | 50 | Min cell error before placing a stroke (Lab distance) |
| Grid factor | 1.0 | Grid cell size relative to brush radius |
| Opacity | 0.9 | Alpha of each stroke |
| Seed | 0 | RNG seed — same seed = same painting |
| Underpainting | Blurred image | Canvas fill before any strokes |
| Fast preview | off | Downscale to 400 px, paint, upscale back |

## Presets

Defined in `main.js` as the `PRESETS` object: `hertzmann`, `loose`, `detailed`, `sketchy`. All preset values have `// TODO: tune values` comments — these are intentionally rough and should be refined. When adding a preset, add it to `PRESETS` and add a matching `<option>` in `index.html`.

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
