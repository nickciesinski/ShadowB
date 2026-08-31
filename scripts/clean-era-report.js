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
const { buildSegments, parseDate, normMarket, supaRowsToArrayRows, toISODate } = require('./weekly-threshold-tune');

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
// Read-only. CLV = how much the market moved toward our side after we bet;
// positive = we beat the close (the durable skill signal). Two sources:
//   • Supabase (v2_clv): a precomputed novig points value at col 33 (COL_CLV_PTS).
//   • Google Sheet (v1/legacy): reconstruct from our odds (col 9) vs the closing
//     odds the grader captured (col 31).
// Supabase rows have NO raw closing american price, so col 31 is empty there —
// prefer col 33 and fall back to the odds calc, matching the threshold tuner.
const COL_ODDS = 9, COL_CLOSE_ODDS = 31, COL_CLV_PTS = 33;

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
    // Supabase (v2_clv) rows carry a precomputed novig points value at
    // COL_CLV_PTS (see supaRowsToArrayRows in weekly-threshold-tune.js): the
    // v2 schema stores CLV as a probability delta, not a raw closing american
    // price, so col 31 is ALWAYS empty for Supabase rows. Prefer the precomputed
    // value; Sheet-sourced rows fall back to the odds-based calc. Mirrors the
    // tuner's leagueApprovedClv exactly, so report and tuner agree.
    const pts = typeof row[COL_CLV_PTS] === 'number'
      ? row[COL_CLV_PTS]
      : clvPoints(row[COL_ODDS], row[COL_CLOSE_ODDS]);
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

// ── Price class — where the vig actually goes ────────────────────
// 2026-08-31. The single most informative cut in this data: books hold
// roughly twice as much on the favourite side, and our CLV changes sign
// across it. Splitting ROI/CLV by price class is what makes the choice
// between "our model is bad" and "we are buying at a bad price" visible.
// Staked (approved) rows only — this is the money question.
const PRICE_CLASSES = ['plus_money', 'minus_money'];
const PRICE_LABEL = { plus_money: 'plus money (>= +100)', minus_money: 'minus money (< +100)' };

function priceClassOf(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o >= 100 ? 'plus_money' : 'minus_money';
}

function emptyPrice() {
  return { n: 0, w: 0, l: 0, p: 0, staked: 0, ret: 0,
           clvN: 0, clvSum: 0, vigN: 0, vigSum: 0, neN: 0, neSum: 0 };
}

function priceSegments(rows, cutoff) {
  const seg = {};
  for (const lg of LEAGUES) {
    seg[lg] = {};
    for (const pc of PRICE_CLASSES) seg[lg][pc] = emptyPrice();
  }
  for (const row of rows) {
    const d = parseDate(row[0]);
    if (!d || d < cutoff) continue;
    const lg = String(row[1] || '').toUpperCase();
    if (!seg[lg]) continue;
    if (String(row[21] || '').trim().toLowerCase() !== 'approved') continue;
    const pc = priceClassOf(row[9]);
    if (!pc) continue;
    const res = String(row[16] || '').trim().toUpperCase();
    if (res !== 'W' && res !== 'L' && res !== 'P') continue;
    const t = seg[lg][pc];
    if (res === 'W') t.w++; else if (res === 'L') t.l++; else t.p++;
    t.n++;
    t.staked += Number(row[10]) || 0;
    t.ret += Number(row[17]) || 0;
    if (typeof row[33] === 'number') { t.clvN++; t.clvSum += row[33]; }
    if (typeof row[34] === 'number') { t.vigN++; t.vigSum += row[34]; }
    if (typeof row[35] === 'number') { t.neN++; t.neSum += row[35]; }
  }
  return seg;
}

function fmtPp(sum, n) {
  if (!n) return '\u2014';
  const v = sum / n;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}pp`;
}

function priceTable(seg, title) {
  let md = `### ${title}\n\n`;
  md += `| League | Price taken | Decided | Staked | ROI | CLV | Vig | Net edge |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  let any = false;
  for (const lg of LEAGUES) {
    for (const pc of PRICE_CLASSES) {
      const t = seg[lg][pc];
      if (!t.n) continue;
      any = true;
      const roi = t.staked > 0 ? `${((t.ret / t.staked) * 100).toFixed(1)}%` : 'n/a';
      md += `| ${lg} | ${PRICE_LABEL[pc]} | ${t.n} | ${t.staked.toFixed(1)}u | ${roi} `
          + `| ${fmtPp(t.clvSum, t.clvN)} | ${fmtPp(t.vigSum, t.vigN)} | ${fmtPp(t.neSum, t.neN)} |\n`;
    }
  }
  if (!any) md += `| \u2014 | \u2014 | 0 | \u2014 | \u2014 | \u2014 | \u2014 | \u2014 |\n`;
  return md + '\n';
}

async function main() {
  const dataStore = require('../src/data-store');
  const db = require('../src/db');

  // 2026-08-09 BUGFIX — this read the Google Sheet, which has NO pick_regime
  // column, so it could not filter regimes and silently blended them. The
  // 2026-08-09 report headlined "Staked ROI: 19.5%" on 156.9u. The split:
  //
  //   v1_daily   1240 decided, 415.9u staked, +107.18u  -> +25.8% ROI
  //   v2_clv      303 decided, 110.8u staked,   -0.50u  ->  -0.5% ROI
  //
  // 80% of the rows behind the headline came from the OLD regime: the same
  // game re-decided every morning with the side flipping as the line moved,
  // graded by a grader that has since been fenced off for mis-grading. That
  // ROI describes a process that no longer exists, and it is the number the
  // roadmap is supposedly graded on. The v2 figure, -0.5%, matches the
  // independently measured net edge of -0.38pp per bet.
  //
  // The threshold tuner was repointed at Supabase on 2026-08-02 for exactly
  // this reason; this report was missed. Same pattern, same reasoning.
  let rows = null;
  let source = 'sheet';
  if (db.isEnabled()) {
    const supaRows = await db.getRecentPerformanceLog(toISODate(CLEAN_ERA_START), { pickRegime: 'v2_clv' });
    if (supaRows && supaRows.length > 0) {
      rows = supaRowsToArrayRows(supaRows);
      source = 'supabase(v2_clv)';
    } else if (supaRows) {
      // Empty is not an error. Do NOT fall back to the Sheet: the Sheet is the
      // v1 mirror, so falling through would silently reintroduce the very rows
      // being excluded — which is how this bug existed in the first place.
      console.log('[clean-era] No v2_clv rows yet — nothing to report. Expected while the new regime accumulates.');
      process.exit(0);
    } else {
      console.warn('[clean-era] Supabase unreachable — refusing to report Sheet (v1-era) numbers as clean-era ROI.');
      process.exit(1);
    }
  }
  if (!rows) {
    console.error('[clean-era] Supabase required for a regime-filtered report.');
    process.exit(1);
  }
  console.log(`[clean-era] read ${rows.length} rows (source: ${source})`);

  const now = new Date();
  const cut7 = new Date(now); cut7.setDate(now.getDate() - 7);
  const cut30 = new Date(now); cut30.setDate(now.getDate() - 30);

  const seg7 = buildSegments(rows, cut7);
  const seg30 = buildSegments(rows, cut30);
  const segClean = buildSegments(rows, CLEAN_ERA_START);
  const clvClean = clvSegments(rows, CLEAN_ERA_START);
  const clv30 = clvSegments(rows, cut30);
  const priceClean = priceSegments(rows, CLEAN_ERA_START);
  const price30 = priceSegments(rows, cut30);

  const pf = portfolio(segClean);
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let md = `# Clean-Era Staked ROI Report — ${dateStr}\n\n`;
  md += `Clean era = picks dated on/after 2026-06-03 (post bug-fix sprint). Pre-6/3 rows excluded.\n`;
  md += `**Regime: \`pick_regime='v2_clv'\` only.** v1_daily rows are excluded — they come from the\n`;
  md += `old daily-re-picking process and their ROI describes a system that no longer exists.\n`;
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

  md += `## Price class — plus money vs laying juice\n\n`;
  md += `Staked bets only. **Net edge = CLV \u2212 vig, which is expected ROI per unit staked** \u2014 `;
  md += `it is measured on every ticket, so it answers "is this segment worth money?" without `;
  md += `waiting for win/loss variance. Books typically hold about twice as much on the favourite `;
  md += `side, so this split usually separates the profitable half of the book from the rest.\n\n`;
  md += priceTable(priceClean, 'Clean era (since 2026-06-03) — by price class');
  md += priceTable(price30, 'Trailing 30 days — by price class');
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

module.exports = { windowTable, portfolio, impliedProb, clvPoints, clvSegments, clvFinalize,
  priceClassOf, priceSegments, priceTable };
