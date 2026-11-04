// Copies the repo's model params into the web app so they're bundled on Vercel
// (config/ lives outside web/ and isn't otherwise included). Runs in pre(dev|build).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', '..', 'config');
const outDir = path.resolve(here, '..', 'app', 'api', 'params', '_data');
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (const lg of ['MLB', 'NBA', 'NFL', 'NHL']) {
  const src = path.join(srcDir, `model-params.${lg}.json`);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(outDir, `model-params.${lg}.json`)); n++; }
}
// 2026-08-31 — the app now displays CALIBRATED numbers, so it needs both the
// shared display math and the fitted coefficients bundled alongside it.
const sharedOut = path.resolve(here, '..', 'app', 'api', 'data', '_shared');
fs.mkdirSync(sharedOut, { recursive: true });
fs.copyFileSync(path.resolve(here, '..', '..', 'src', 'calibrated-display.mjs'),
                path.join(sharedOut, 'calibrated-display.mjs'));
let c = 0;
for (const lg of ['MLB', 'NBA', 'NFL', 'NHL']) {
  const src = path.join(srcDir, `prob-calibration.${lg}.json`);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(sharedOut, `prob-calibration.${lg}.json`)); c++; }
}
console.log(`[copy-params] copied ${n} param file(s) -> ${outDir}`);
console.log(`[copy-params] copied display module + ${c} calibration map(s) -> ${sharedOut}`);

// 2026-11-03 — the Rankings tab shows each injury's replacement and impact
// with the same code the model uses.
const rankShared = path.resolve(here, '..', 'app', 'api', 'rankings', '_shared');
fs.mkdirSync(rankShared, { recursive: true });
fs.copyFileSync(path.resolve(here, '..', '..', 'src', 'injury-replacement.js'),
                path.join(rankShared, 'injury-replacement.js'));
console.log(`[copy-params] copied injury-replacement.js -> ${rankShared}`);
// Which rating formula the injury tuner has chosen per league, so the tab
// shows the same scores the model is using.
fs.copyFileSync(path.resolve(here, '..', '..', 'config', 'injury-tuning.json'),
                path.join(rankShared, 'injury-tuning.json'));
