// Copies the voice-activity-detection runtime into public/vad/ so the browser loads it
// from AWB itself (no third-party CDN at runtime). Run before `vite` / `vite build`.
// docs/voice-operator.md "대화 모드".
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'vad');
// Neither package exports ./package.json — resolve a shipped entry and take its folder.
const vadDist = dirname(require.resolve('@ricky0123/vad-web'));
const ortDist = dirname(createRequire(join(vadDist, 'index.js')).resolve('onnxruntime-web/wasm'));

const files = [
  [vadDist, 'vad.worklet.bundle.min.js'],
  [vadDist, 'silero_vad_v6.onnx'],
  // `onnxruntime-web/wasm` (what vad-web imports) loads exactly this glue + binary pair.
  [ortDist, 'ort-wasm-simd-threaded.mjs'],
  [ortDist, 'ort-wasm-simd-threaded.wasm'],
];

mkdirSync(out, { recursive: true });
for (const [dir, name] of files) {
  const src = join(dir, name);
  const dest = join(out, name);
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue;
  copyFileSync(src, dest);
}
console.log(`vad assets → ${out}`);
