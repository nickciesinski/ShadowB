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
  const src = path.join(srcDir, `calibration.${lg}.json`);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(sharedOut, `calibration.${lg}.json`)); c++; }
}
console.log(`[copy-params] copied ${n} param file(s) -> ${outDir}`);
console.log(`[copy-params] copied display module + ${c} calibration map(s) -> ${sharedOut}`);
