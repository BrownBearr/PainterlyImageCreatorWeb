# Painterly Image Creator

A browser-based stroke-painting renderer. Upload a photo and it gets redrawn as an oil or watercolour-style painting — entirely in your browser, no server, no install.

Based on Aaron Hertzmann's *Painterly Rendering with Curved Brush Strokes of Multiple Sizes* (1998).

---

## How it works

The algorithm paints in layers, coarsest brush first. Each layer:

1. Blurs the reference image to the current brush scale
2. Computes a per-pixel error map (how wrong the canvas looks vs the reference)
3. Walks a shuffled grid of cells and, wherever error is high enough, grows a curved stroke that follows the edge direction of the image
4. Stops adding strokes once the canvas matches the reference closely enough

Finer layers fill in detail that the coarser strokes missed.

---

## Modes

Switch between **Image**, **Video**, and **Batch** using the tabs in the header.

### Image
Render a single photo. Drop a file into the upload zone (or click to browse), adjust parameters, then click **▶ Render**. When finished, click **↓ Download PNG**.

### Video
Drop a video file into the upload zone. Every frame is extracted, painted, and re-encoded. Output is a `.webm` file (VP8) on Chrome/Edge, or a ZIP of PNG frames on other browsers.

### Batch
Select multiple images at once. On Chrome/Edge you will be asked to pick an output folder and files are saved there directly. On other browsers the results download as a single ZIP.

---

## Parameter reference

All parameters are shared across Image, Video, and Batch modes.

---

### Brush Layers

Controls how many passes the algorithm makes and how large the strokes are in each pass.

#### Radii
**Format:** comma-separated integers, e.g. `8, 4, 2`

Each number is the pixel radius of one brush layer. The algorithm runs a full pass for each value, working from largest to smallest. Larger values produce bold, impressionistic coverage; smaller values recover fine detail.

- **Fewer layers** → faster, more abstract result
- **More layers** → slower, more detailed result
- **Larger first number** → broader, paintier strokes
- **Smaller last number** → finer detail recovered

Typical ranges: coarse `4–16`, fine `1–4`. Fast preview automatically collapses to the first (largest) radius only.

---

#### Max stroke length
**Range:** 1 – 64 &emsp; **Default:** 16

The maximum number of steps a single stroke can grow before it is forced to stop. Longer strokes produce sweeping, flowing brushwork. Shorter strokes produce a more stippled or mosaic look.

---

#### Min stroke length
**Range:** 1 – 32 &emsp; **Default:** 4

A stroke must reach at least this many steps before it can stop early (the early-stop condition checks whether the stroke colour is diverging from the reference). Raising this prevents very short dabs and keeps strokes looking deliberate.

Keep **Min ≤ Max** — if they are equal every stroke is exactly that many steps long.

---

#### Curvature
**Range:** 0.0 – 1.0 &emsp; **Default:** 1.0

How strongly strokes bend to follow image edges.

- **1.0** — strokes curve aggressively along contours (classic painterly look)
- **0.0** — strokes travel in a straight line in whichever direction they started
- Values in between blend the two behaviours

---

### Rendering

Controls how the algorithm decides where to place strokes and how they look on the canvas.

---

#### Error threshold T
**Range:** 1 – 200 &emsp; **Default:** 50

The minimum average error a grid cell must have before a stroke is placed there. Error is measured as Lab colour distance between the blurred reference and the current canvas.

- **Lower T** → strokes placed almost everywhere, very dense coverage, slower
- **Higher T** → strokes only placed where the canvas is clearly wrong, sparser and faster

The first (coarsest) layer always paints every cell regardless of threshold, ensuring full canvas coverage.

---

#### Grid factor
**Range:** 0.25 – 3.0 &emsp; **Default:** 1.0

Scales the grid cell size relative to the brush radius. One cell is checked per grid square, so this controls stroke density.

- **< 1.0** → denser grid, more strokes, overlapping coverage
- **1.0** → one stroke candidate per brush-width cell (standard)
- **> 1.0** → sparser grid, fewer strokes, gaps between them

---

#### Opacity
**Range:** 0.1 – 1.0 &emsp; **Default:** 0.9

The alpha value of each stroke as it blends onto the canvas. Lower opacity lets previous layers show through, creating a glazing effect. Higher opacity makes each stroke fully cover what is underneath.

---

#### Hue jitter
**Range:** 0.0 – 1.0 &emsp; **Default:** 0

Per-stroke random offset applied to the stroke's hue. At 1.0 the hue can shift up to ±180°. Adds natural colour variation across strokes — visible at values as low as 0.05.

---

#### Saturation jitter
**Range:** 0.0 – 1.0 &emsp; **Default:** 0

Per-stroke random offset applied to the stroke's saturation. At 1.0 the saturation can shift by ±100%. Combine with hue jitter for full chromatic variation.

---

#### Value jitter
**Range:** 0.0 – 1.0 &emsp; **Default:** 0

Per-stroke random offset applied to the stroke's brightness. Adds light/dark variation across strokes without changing hue or saturation.

---

#### Palette size
**Range:** 0 – 32 &emsp; **Default:** 0 (off)

When greater than 1, stroke colours are snapped to a palette of N colours derived from the source image via k-means clustering. Produces a flat, posterised or screen-print quality. Higher values allow more colour nuance.

---

#### Dry-brush falloff
**Range:** 0.0 – 1.0 &emsp; **Default:** 0 (off)

Opacity decreases along the stroke from head to tail by this amount. At 1.0 the tail is fully transparent. Simulates a brush running out of paint mid-stroke.

---

#### Direction smoothing σ
**Range:** 0 – 10 &emsp; **Default:** 0 (off)

When greater than 0, replaces the raw per-pixel Sobel gradient with a direction field derived from the structure tensor (Gaussian-smoothed gradient products). Higher values produce smoother, more coherent stroke flow across regions with ambiguous edges. Costs one extra Gaussian blur pass per layer.

---

#### Impasto strength
**Range:** 0.0 – 2.0 &emsp; **Default:** 0 (off)

Controls how much each stroke adds to the height buffer used for impasto lighting. At 0 the height buffer is not computed. Raise together with **Impasto light strength** to see an effect — raised stroke edges will catch light.

---

#### Impasto light strength
**Range:** 0.0 – 2.0 &emsp; **Default:** 0 (off)

Scales the directional lighting applied to the height map after painting. At 0 the lighting pass is skipped. At 1.0 the effect is strong — stroke edges facing the light angle are brightened, those facing away are darkened. The ambient term is fixed at 0.6 so shadowed areas never go fully black.

---

#### Light angle (°)
**Range:** 0 – 360 &emsp; **Default:** 45

The azimuth of the directional light used for impasto lighting, in degrees. 0° = right, 90° = up, 180° = left, 270° = down. Only affects the image when **Impasto light strength > 0**.

---

#### Underpainting
**Options:** Blurred image · Average color · None

What the canvas is filled with before any strokes are placed.

| Option | Description |
|---|---|
| **Blurred image** | A Gaussian blur of the source (at the coarsest radius) fills the canvas. Strokes paint over a soft, colour-coherent base — gaps between strokes are never plain white. |
| **Average color** | The mean colour of the entire image fills the canvas. Neutral starting point; strokes define all the colour variation. |
| **None** | Canvas starts white. Gaps between strokes remain white, giving a looser, sketchier feel. |

---

#### Fast preview
**Default:** off

When enabled, the image is downscaled to a maximum of 400 px on either side before painting, then the result is upscaled back to the original size. Produces a rough approximation in a fraction of the time — useful for dialling in parameters before a full-resolution render. Only the largest brush radius is used.

---

### Presets

The **Preset** dropdown sets all parameters at once. Four built-in presets are provided:

| Preset | Character |
|---|---|
| **Impressionist** | Curved medium strokes, subtle colour jitter — Monet / Renoir |
| **Expressionist** | Long bold strokes, strong colour distortion — van Gogh / Munch |
| **Pointillist** | Very short dabs on a fine grid, no curvature — Seurat / Signac |
| **Wash** | Large translucent strokes with high colour jitter — loose watercolour |

Selecting a preset fills all controls; any subsequent edit switches the dropdown to **Custom**. Preset definitions live in the `PRESETS` object in `main.js` and are easy to tune.

---

### Detail Mask (optional, Image mode)

Upload a grayscale PNG or JPEG to locally modulate the error threshold T.

- **White pixels** → effective T approaches 0, so nearly every cell gets a stroke (maximum detail)
- **Black pixels** → T is unchanged (normal behaviour)
- Intermediate greys scale linearly between the two

Use this to force fine detail in faces or focal points while leaving the background loose. A future saliency pass could populate the same mask buffer automatically.

---

### Video Options

#### Output FPS
**Range:** 1 – 60 &emsp; **Default:** 24

Frames per second of the output video. Higher values produce smoother motion but increase render time proportionally.

---

#### Frame diff threshold
**Range:** 0 – 50 &emsp; **Default:** 0 (off)

When greater than 0, enables temporal coherence: the previous frame's painted canvas is reused as the starting point for the current frame, and only grid cells where the source video changed by more than this amount (average RGB channel difference) are repainted. Unchanged regions keep their existing strokes, eliminating most inter-frame flicker. Raise the value to keep more of the previous frame; lower it to repaint more aggressively on subtle motion.

---

## Actions

| Button | What it does |
|---|---|
| **▶ Render / Process Video / Process Batch** | Starts rendering using the current parameters |
| **✕ Cancel** | Stops the current render immediately |
| **↓ Download PNG** | Saves the rendered image (Image mode only) |

The gold progress bar shows overall layer progress. A second bar (visible during Video and Batch) shows per-frame painting progress.

---

## Deployment

No build step required. The project is four plain JavaScript files served as static assets.

**Cloudflare Pages:** connect the repository and set the build output directory to `/` (root). Leave the build command blank.

**Locally:** any static file server works, e.g.:
```
npx serve .
```

> **Note:** Video encoding uses the browser's [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) (Chrome/Edge 94+). On Firefox and Safari the video output falls back to a ZIP of PNG frames. The File System Access API for batch folder export is also Chrome/Edge only; other browsers receive a ZIP download.

---

## Browser support

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Image rendering | ✅ | ✅ | ✅ |
| Video → WebM | ✅ | ⬇ ZIP | ⬇ ZIP |
| Batch → folder | ✅ | ⬇ ZIP | ⬇ ZIP |
