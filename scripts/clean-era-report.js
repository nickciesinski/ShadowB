'use strict';
// =============================================================
// scripts/clean-era-report.js  (R0.2 — honest measurement layer)
//
// One trustworthy scoreboard: STAKED (approved) ROI + win% by
// league x market, on clean-era data only (>= CLEAN_ERA_START).
// Pre-6/3 rows are corrupted by the June bug-fix sprint and are
// excluded. This is the number the ROI-Positive roadmap is graded on.
//
// Reuses the threshold tuner's proven Performance-Log reader and
// segment aggregation (buildSegments/finalize) so the math matches
// the tuner exactly — no parallel, drift-prone implementation.
//
// Writes a dated markdown report to clean-era-reports/ and prints it.
// Runs in CI (needs Sheets/Supabase secrets). Usage:
//   node scripts/clean-era-report.js
// =============================================================

const fs = require('fs');
const path = require('path');
const { buildSegments, parseDate, normMarket } = require('./weekly-threshold-tune');

const LEAGUES = ['MLB', 'NBA', 'NHL', 'NFL'];
const MARKETS = ['moneyline', 'spread', 'total'];
const CLEAN_ERA_START = new Date(2026, 5, 3); // 2026-06-03, bugs fixed
const OUT_DIR = path.join(__dirname, '..', 'clean-era-reports');

function fmtAgg(a) {
  if (!a || a.graded === 0) return '—';
  const win = a.winPct == null ? '—' : `${a.winPct}%`;
  const roi = a.roiPct == null ? '—' : `${a.roiPct >= 0 ? '+' : ''}${a.roiPct}%`;
  return `${a.wins}-${a.losses}${a.pushes ? '-' + a.pushes : ''} / ${win} / ROI ${roi} (n=${a.graded}, staked ${a.staked.toFixed(1)}u, ret ${a.ret >= 0 ? '+' : ''}${a.ret.toFixed(2)}u)`;
}

// Roll the per-league byMarket aggregates up into a single staked-vs-all view.
function windowTable(seg, title) {
  let md = `### ${title}\n\n`;
  md += `| League | Market | All | Approved (staked) | Tracking-only |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const lg of LEAGUES) {
    const m = seg[lg].byMarket;
    let any = false;
    for (const mk of MARKETS) {
      const all = m[mk].all;
      if (all.graded === 0) continue;
      any = true;
      md += `| ${lg} | ${mk} | ${fmtAgg(all)} | ${fmtAgg(m[mk].approved)} | ${fmtAgg(m[mk].tracking)} |\n`;
    }
    if (any) md += `| **${lg}** | **all** | ${fmtAgg(seg[lg].all)} | ${fmtAgg(seg[lg].approved)} | ${fmtAgg(seg[lg].tracking)} |\n`;
  }
  return md + '\n';
}

// Portfolio line: total approved staked/return across all leagues+markets.
function portfolio(seg) {
  let staked = 0, ret = 0, w = 0, l = 0, p = 0;
  for (const lg of LEAGUES) {
    const a = seg[lg].approved;
    staked += a.staked; ret += a.ret; w += a.wins; l += a.losses; p += a.pushes;
  }
  const dec = w + l;
  const roi = staked > 0 ? ((ret / staked) * 100).toFixed(1) : 'n/a';
  const win = dec > 0 ? ((w / dec) * 100).toFixed(1) : 'n/a';
  return { staked, ret, w, l, p, roi, win };
}

// ── CLV (closing-line value) — R1.1 ──────────────────────────────
// Read-only: our odds live in Performance Log col 9, the closing odds the
// grader captured live in col 31. CLV = how much the market moved toward our
// side after we bet. Positive = we beat the close (the durable skill signal).
const COL_ODDS = 9, COL_CLOSE_ODDS = 31;

const { impliedProb, clvPoints, emptyClv, clvFinalize } = require('./clv-lib');

// Bucket CLV by league × market × {all,approved,tracking} over a window.
function clvSegments(rows, cutoff) {
  const seg = {};
  for (const lg of LEAGUES) {
    seg[lg] = { all: emptyClv(), approved: emptyClv(), tracking: emptyClv(), byMarket: {} };
    for (const mk of MARKETS) seg[lg].byMarket[mk] = { all: emptyClv(), approved: emptyClv(), tracking: emptyClv() };
  }
  for (const row of rows) {
    const d = parseDate(row[0]);
    if (!d || d < cutoff) continue;
    const lg = String(row[1] || '').toUpperCase();
    if (!seg[lg]) continue;
    const pts = clvPoints(row[COL_ODDS], row[COL_CLOSE_ODDS]);
    if (pts == null) continue; // no closing snapshot for this bet
    const mk = normMarket(row[2]);
    const appr = String(row[21] || '').trim().toLowerCase();
    const bucket = appr === 'approved' ? 'approved' : 'tracking';
    for (const t of [seg[lg].all, seg[lg][bucket]]) { t.n++; if (pts > 0) t.beats++; t.sumPts += pts; }
    if (seg[lg].byMarket[mk]) {
      for (const t of [seg[lg].byMarket[mk].all, seg[lg].byMarket[mk][bucket]]) { t.n++; if (pts > 0) t.beats++; t.sumPts += pts; }
    }
  }
  return seg;
}

function fmtClv(c) {
  const f = clvFinalize(c);
  if (!f.n) return '—';
  return `beat ${f.beatPct}% / avg ${f.avgPts >= 0 ? '+' : ''}${f.avgPts}pp (n=${f.n})`;
}

function clvTable(seg, title) {
  let md = `### ${title}\n\n`;
  md += `| League | Market | All | Approved (staked) | Tracking-only |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const lg of LEAGUES) {
    const m = seg[lg].byMarket;
    let any = false;
    for (const mk of MARKETS) {
      if (m[mk].all.n === 0) continue;
      any = true;
      md += `| ${lg} | ${mk} | ${fmtClv(m[mk].all)} | ${fmtClv(m[mk].approved)} | ${fmtClv(m[mk].tracking)} |\n`;
    }
    if (any) md += `| **${lg}** | **all** | ${fmtClv(seg[lg].all)} | ${fmtClv(seg[lg].approved)} | ${fmtClv(seg[lg].tracking)} |\n`;
  }
  return md + '\n';
}

async function main() {
  const dataStore = require('../src/data-store');
  const raw = await dataStore.read('performanceRows');
  if (!raw || raw.length < 2) { console.error('[clean-era] Performance Log empty/unreadable'); process.exit(1); }
  const rows = raw.slice(1);
  console.log(`[clean-era] read ${rows.length} rows`);

  const now = new Date();
  const cut7 = new Date(now); cut7.setDate(now.getDate() - 7);
  const cut30 = new Date(now); cut30.setDate(now.getDate() - 30);

  const seg7 = buildSegments(rows, cut7);
  const seg30 = buildSegments(rows, cut30);
  const segClean = buildSegments(rows, CLEAN_ERA_START);
  const clvClean = clvSegments(rows, CLEAN_ERA_START);
  const clv30 = clvSegments(rows, cut30);

  const pf = portfolio(segClean);
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let md = `# Clean-Era Staked ROI Report — ${dateStr}\n\n`;
  md += `Clean era = picks dated on/after 2026-06-03 (post bug-fix sprint). Pre-6/3 rows excluded.\n`;
  md += `**The roadmap is graded on the "Approved (staked)" column.**\n\n`;
  md += `## Headline — clean-era staked portfolio\n\n`;
  md += `- **Staked ROI: ${pf.roi}%** on ${pf.staked.toFixed(1)}u risked (return ${pf.ret >= 0 ? '+' : ''}${pf.ret.toFixed(2)}u)\n`;
  md += `- Record (decided): ${pf.w}-${pf.l}${pf.p ? '-' + pf.p : ''} / ${pf.win}%\n`;
  md += `- Target: this number > 0, sustained over a rolling 30-day window.\n\n`;
  md += windowTable(segClean, 'Clean era (since 2026-06-03) — by league × market');
  md += windowTable(seg30, 'Trailing 30 days');
  md += windowTable(seg7, 'Trailing 7 days');
  md += `## CLV — closing-line value (R1.1)\n\n`;
  md += `CLV = market move toward our side after we bet (our odds vs closing odds). `;
  md += `**This is the leading indicator** — it gives signal on every bet immediately, unlike W/L. `;
  md += `Sustained positive CLV on staked bets is the durable proof the edge is real, not luck. `;
  md += `Rows without a closing snapshot are excluded from CLV counts.\n\n`;
  md += clvTable(clvClean, 'Clean era (since 2026-06-03) — CLV by league × market');
  md += clvTable(clv30, 'Trailing 30 days — CLV');
  md += `## Still W/L-noisy\n\n`;
  md += `- Treat ROI segments with n<20 as not-yet-significant; lean on CLV beat% there.\n`;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${dateStr}.md`), md);
  console.log(`[clean-era] wrote clean-era-reports/${dateStr}.md`);
  console.log('\n' + md);
}

if (require.main === module) {
  main().catch(e => { console.error('[clean-era] FATAL:', e.message); process.exit(1); });
}

module.exports = { windowTable, portfolio, impliedProb, clvPoints, clvSegments, clvFinalize };
