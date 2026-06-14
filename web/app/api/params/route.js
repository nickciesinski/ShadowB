import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Params are copied into ./_data at prebuild (web/scripts/copy-params.mjs). Fall
// back to the repo's config/ dir for local dev where cwd is the repo root.
function loadParams() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '_data'),
    path.resolve(process.cwd(), 'config'),
    path.resolve(process.cwd(), '..', 'config'),
  ];
  for (const dir of candidates) {
    try {
      const out = {};
      let found = 0;
      for (const lg of ['MLB', 'NBA', 'NFL', 'NHL']) {
        const fp = path.join(dir, `model-params.${lg}.json`);
        if (fs.existsSync(fp)) { out[lg] = JSON.parse(fs.readFileSync(fp, 'utf8')); found++; }
      }
      if (found > 0) return { ok: true, source: dir, params: out };
    } catch (e) { /* try next candidate */ }
  }
  return { ok: false, source: null, params: {} };
}

export async function GET() {
  const res = loadParams();
  return NextResponse.json(
    { ...res, lastUpdated: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' }, status: res.ok ? 200 : 404 }
  );
}
