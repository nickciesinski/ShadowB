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
console.log(`[copy-params] copied ${n} param file(s) -> ${outDir}`);
