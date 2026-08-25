'use strict';

// CLI determinism/parity runner. Evaluates the worker's algorithm code directly
// in Node (same V8 float semantics as Chrome) and prints, per config:
//   determinism  — two seed-1 runs hash identically
//   seed-effect  — a seed-2 run hashes differently
//   baseline     — seed-1 hash vs the committed PARITY_BASELINE
//
// Usage:  node tools/parity-node.js [--baseline]
//   --baseline  print a PARITY_BASELINE object to paste into parity-common.js

const fs = require('fs');
const path = require('path');
const common = require('./parity-common.js');

const ROOT = path.join(__dirname, '..');
const WORKER_FILES = ['brush-texture.js', 'styles/shiraishi.js', 'styles/stipple.js', 'styles/watercolor.js', 'worker.js'];

function buildPaintify() {
  const src = WORKER_FILES
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  // `self` is a stub so the onmessage assignment is harmless; importScripts is
  // a no-op because everything is already concatenated (styles/*.js included
  // via WORKER_FILES as they are added).
  const factory = new Function('self', 'importScripts', src + '\n;return paintify;');
  return factory({}, function () {});
}

async function main() {
  const wantBaseline = process.argv.includes('--baseline');
  const paintify = buildPaintify();
  const img = common.makeParityImage();

  const run = async (params) => {
    const result = await paintify(
      { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height },
      params, function () {}, null, function () {}
    );
    return common.parityHash(result.data);
  };

  const baseline = {};
  let failures = 0;

  for (const cfg of common.PARITY_CONFIGS) {
    const t0 = Date.now();
    const h1a = await run({ ...cfg.params, seed: 1 });
    const h1b = await run({ ...cfg.params, seed: 1 });
    const h2 = await run({ ...cfg.params, seed: 2 });
    const ms = Date.now() - t0;

    const det = h1a === h1b;
    const seedFx = h1a !== h2;
    const ref = common.PARITY_BASELINE[cfg.name];
    const base = ref === undefined ? 'n/a' : (ref === h1a ? 'MATCH' : `DIFF (ref ${ref})`);
    if (!det || !seedFx || (ref !== undefined && ref !== h1a)) failures++;

    baseline[cfg.name] = h1a;
    console.log(
      `${cfg.name.padEnd(22)} ${h1a}  det:${det ? 'ok' : 'FAIL'}  seed:${seedFx ? 'ok' : 'FAIL'}  baseline:${base}  (${ms}ms)`
    );
  }

  if (wantBaseline) {
    console.log('\nconst PARITY_BASELINE = {');
    for (const [k, v] of Object.entries(baseline)) console.log(`  '${k}': '${v}',`);
    console.log('};');
  }

  if (failures > 0) {
    console.error(`\n${failures} config(s) failed`);
    process.exit(1);
  }
  console.log('\nAll configs passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
