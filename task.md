# Task — Watercolor style (Bousseau 2006) + bundled paper background

Plan: /Users/shivav./.claude/plans/plan-add-multiple-ethereal-acorn.md

- [x] styles/watercolor.js — paintWatercolor (abstraction washes + wash strokes + Bousseau effects)
- [x] worker.js — importScripts + ALGORITHMS registry + applyPaperTexture pass + call site
- [x] assets/paper.png — generate + commit bundled tileable paper texture (generator: tools/make-paper.js)
- [x] main.js — load paper asset, getParams (watercolor + paper), preset, applyPreset, wiring
- [x] index.html — algorithm option, watercolor controls, paper control, washflow preset
- [x] tools/parity-common.js + parity-node.js — register watercolor, add configs + baselines
- [x] Parity: 19 existing MATCH; watercolor/paper deterministic + baselined (22 configs total)
- [x] Visual preview (watercolor-plain / watercolor-paper / watercolor-whitepaper / hertzmann-paper)
- [x] 10-frame video smoke test for watercolor (static frame ×10 → one hash)
- [x] CLAUDE.md + README.md docs

Notes:
- tools/parity.html needed no change: it spawns the real worker.js rather than
  concatenating style files, so styles/watercolor.js loads via importScripts.
- Not verified: interactive browser run (no browser available in this
  environment). Static server serves /, worker.js, styles/watercolor.js,
  assets/paper.png and main.js at 200, and every getElementById id in main.js
  resolves against index.html.
