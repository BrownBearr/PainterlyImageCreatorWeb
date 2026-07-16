# onnxruntime-web 1.27.0 (vendored)

`ort.min.js` is the UMD bundle from the `onnxruntime-web@1.27.0` npm package
(MIT license), loaded in the worker via `importScripts` only when the Neural
algorithm is selected. This is the repo's one documented exception to the
no-dependencies rule.

The heavy runtime artifacts are NOT in the repo (the WebGPU wasm exceeds
Cloudflare Pages' 25 MB file limit). They are served from the CDN and fetched
on demand — `neural.js` points `ort.env.wasm.wasmPaths` at
`https://cdn.shivav.space/file/daysofshiva-source/painterly/ort/1.27.0/`, which must contain:

- `ort-wasm-simd-threaded.wasm` + `ort-wasm-simd-threaded.mjs` (wasm EP)
- `ort-wasm-simd-threaded.jsep.wasm` + `ort-wasm-simd-threaded.jsep.mjs` (WebGPU EP)

The Paint Transformer model lives one level up as
`painterly/paint-transformer-v1.fp16.onnx` (built by
`tools/convert_paint_transformer.py`). `tools/upload_neural_assets.py`
uploads everything.

To upgrade ORT: `npm pack onnxruntime-web`, replace `ort.min.js`, upload the
four runtime files under a new `ort/<version>/` prefix, and bump
`NEURAL_ORT_WASM_BASE` in `neural.js`.
