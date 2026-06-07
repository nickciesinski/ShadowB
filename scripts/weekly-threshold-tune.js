'use strict';
// =============================================================
// scripts/weekly-threshold-tune.js
// Weekly approval-threshold auto-tuner (runs in GitHub Actions, Sundays).
//
// Reads the Performance Log, computes per league × market performance
// for the trailing 7 and 30 days, decides whether any league's approval
// thresholds should move, edits config/approval-thresholds.json in place,
// and writes a dated markdown review to threshold-reviews/.
//
// The decision logic is a deterministic codification of the weekly tuning
// rules. It is intentionally conservative:
//   - Never moves more than 2 thresholds per league per week
//   - Never moves a single threshold by more than 1.0 in a week
//   - Skips a league with < 20 graded bets in the 7-day window
//   - Does not tighten a league that is profitable (ROI > 3%)
//
// Usage:  node scripts/weekly-threshold-tune.js [--dry-run]
// =============================================================

const fs = require('fs');
const path = require('path');

const CFG_PATH = path.join(__dirname, '..', 'config', 'approval-thresholds.json');
const REVIEW_DIR = path.join(__dirname, '..', 'threshold-reviews');

const LEAGUES = ['MLB', 'NBA', 'NHL', 'NFL'];
const MARKETS = ['moneyline', 'spread', 'total'];

// Performance Log column indices (0-based). See predictions.js column legend:
// A date, B league, C market, ... J odds, K units, ... Q result(16), R unit_return(17),
// ... V approval_status(21).
const COL = { DATE: 0, LEAGUE: 1, MARKET: 2, ODDS: 9, UNITS: 10, RESULT: 16, RETURN: 17, APPROVAL: 21 };

function round(n, d = 2) { const f = Math.pow(10, d); return Math.round(n * f) / f; }

function parseDate(s) {
  if (!s) return null;
  // Format MM/D/YYYY (no zero padding)
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d; }
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

function normMarket(s) {
  const m = String(s || '').toLowerCase();
  if (m.includes('money') || m === 'h2h') return 'moneyline';
  if (m.includes('spread') || m.includes('run line') || m.includes('puck')) return 'spread';
  if (m.includes('total') || m === 'over' || m === 'under') return 'total';
  return m;
}

function emptyAgg() { return { wins: 0, losses: 0, pushes: 0, staked: 0, ret: 0 }; }
function addRow(agg, units, ret, result) {
  if (result === 'W') agg.wins++;
  else if (result === 'L') agg.losses++;
  else if (result === 'P') agg.pushes++;
  agg.staked += units;
  agg.ret += ret;
}
function finalize(agg) {
  const graded = agg.wins + agg.losses + agg.pushes;
  const decided = agg.wins + agg.losses;
  return {
    ...agg,
    graded,
    winPct: decided > 0 ? round((agg.wins / decided) * 100, 1) : null,
    roiPct: agg.staked > 0 ? round((agg.ret / agg.staked) * 100, 1) : null,
  };
}

// Build nested segment stats for a given day window.
function buildSegments(rows, cutoff) {
  // seg[league] = { all, byMarket{m:{all,approved,tracking}}, approved, tracking }
  const seg = {};
  for (const lg of LEAGUES) {
    seg[lg] = { all: emptyAgg(), approved: emptyAgg(), tracking: emptyAgg(), byMarket: {} };
    for (const mk of MARKETS) seg[lg].byMarket[mk] = { all: emptyAgg(), approved: emptyAgg(), tracking: emptyAgg() };
  }
  for (const row of rows) {
    const d = parseDate(row[COL.DATE]);
    if (!d || d < cutoff) continue;
    const lg = String(row[COL.LEAGUE] || '').toUpperCase();
    if (!seg[lg]) continue;
    const result = String(row[COL.RESULT] || '').trim().toUpperCase();
    if (result !== 'W' && result !== 'L' && result !== 'P') continue; // ungraded
    const mk = normMarket(row[COL.MARKET]);
    const units = parseFloat(row[COL.UNITS]); if (!Number.isFinite(units)) continue;
    const ret = parseFloat(row[COL.RETURN]) || 0;
    const appr = String(row[COL.APPROVAL] || '').trim().toLowerCase();
    const bucket = appr === 'approved' ? 'approved' : 'tracking';

    addRow(seg[lg].all, units, ret, result);
    addRow(seg[lg][bucket], units, ret, result);
    if (seg[lg].byMarket[mk]) {
      addRow(seg[lg].byMarket[mk].all, units, ret, result);
      addRow(seg[lg].byMarket[mk][bucket], units, ret, result);
    }
  }
  // finalize
  for (const lg of LEAGUES) {
    seg[lg].all = finalize(seg[lg].all);
    seg[lg].approved = finalize(seg[lg].approved);
    seg[lg].tracking = finalize(seg[lg].tracking);
    for (const mk of MARKETS) {
      seg[lg].byMarket[mk].all = finalize(seg[lg].byMarket[mk].all);
      seg[lg].byMarket[mk].approved = finalize(seg[lg].byMarket[mk].approved);
      seg[lg].byMarket[mk].tracking = finalize(seg[lg].byMarket[mk].tracking);
    }
  }
  return seg;
}

// Pure decision function — exported for tests.
// current = merged thresholds for the league (defaults + override).
function decideLeagueChange(league, s7, s30, current) {
  const a7 = s7.all, a30 = s30.all;
  const reasons = [];
  const changes = {};
  const n = a7.graded;

  if (n < 20) return { changes, reasons, note: `n=${n} (<20 graded in 7d) — skip` };
  if (a7.roiPct === null) return { changes, reasons, note: 'no staked volume — skip' };

  const roi = a7.roiPct;
  const profitable = roi > 3;

  if (roi < -10 && !profitable) {
    const severe = roi < -20;
    const step = severe ? 1.0 : 0.5;          // never > 1.0 per week
    const cur = current.minEdgePct;
    const next = round(Math.min(cur + step, cur + 1.0, 6.0), 2);
    if (next > cur) {
      changes.minEdgePct = next;
      reasons.push(`7d ROI ${roi}% on ${n} bets — raise minEdgePct ${cur}→${next}`);
    }
    // Second knob only if severe AND the 30d window confirms the bleed.
    if (severe && a30.graded >= 20 && a30.roiPct !== null && a30.roiPct < -10) {
      const c = current.minConfidence;
      const nc = Math.min(c + 1, 8);
      if (Object.keys(changes).length < 2 && nc > c) {
        changes.minConfidence = nc;
        reasons.push(`severe bleed confirmed by 30d ROI ${a30.roiPct}% — raise minConfidence ${c}→${nc}`);
      }
    }
  } else if (roi > 8) {
    const cur = current.minEdgePct;
    const next = round(Math.max(cur - 0.5, 1.5), 2);
    if (next < cur) {
      changes.minEdgePct = next;
      reasons.push(`7d ROI +${roi}% on ${n} bets — loosen minEdgePct ${cur}→${next}`);
    }
  }

  // Approval-filter sanity flag (reported, not auto-acted): approved doing
  // markedly worse than tracking-only means the filter is selecting badly.
  let flag = null;
  const ap = s7.approved, tr = s7.tracking;
  if (ap.graded >= 15 && tr.graded >= 15 && ap.roiPct !== null && tr.roiPct !== null
      && ap.roiPct < tr.roiPct - 8) {
    flag = `approved ROI ${ap.roiPct}% << tracking ROI ${tr.roiPct}% (n_appr=${ap.graded}) — approval filter may be miscalibrated; manual review`;
  }

  return { changes, reasons, flag, note: Object.keys(changes).length ? null : `ROI ${roi}% within band — hold` };
}

function mergedThresholds(cfg, league) {
  return { ...cfg.default, ...((cfg.leagues && cfg.leagues[league]) || {}) };
}

function fmtAgg(a) {
  if (!a || a.graded === 0) return '—';
  const w = a.winPct === null ? '—' : `${a.winPct}%`;
  const r = a.roiPct === null ? '—' : `${a.roiPct}%`;
  return `${a.wins}-${a.losses}${a.pushes ? '-' + a.pushes : ''} / ${w} / ${r} (n=${a.graded})`;
}

function buildReview(dateStr, seg7, seg30, decisions) {
  let md = `# Threshold Auto-Tune — ${dateStr}\n\n`;
  md += `Trailing 7-day performance by league × market (record / win% / ROI / n). ROI = unit_return ÷ units staked.\n\n`;
  md += `| League | Market | 7d all | 7d approved | 7d tracking |\n|---|---|---|---|---|\n`;
  for (const lg of LEAGUES) {
    for (const mk of MARKETS) {
      const b = seg7[lg].byMarket[mk];
      if (b.all.graded === 0) continue;
      md += `| ${lg} | ${mk} | ${fmtAgg(b.all)} | ${fmtAgg(b.approved)} | ${fmtAgg(b.tracking)} |\n`;
    }
    md += `| **${lg}** | **all** | **${fmtAgg(seg7[lg].all)}** | ${fmtAgg(seg7[lg].approved)} | ${fmtAgg(seg7[lg].tracking)} |\n`;
  }
  md += `\n## Changes applied\n\n`;
  const applied = decisions.filter(d => Object.keys(d.changes).length);
  if (!applied.length) {
    md += `None. All leagues either within the acceptable ROI band, below the 20-bet minimum, or profitable.\n`;
  } else {
    for (const d of applied) md += `- **${d.league}**: ${d.reasons.join('; ')}\n`;
  }
  md += `\n## Monitored / held\n\n`;
  for (const d of decisions) {
    if (Object.keys(d.changes).length) continue;
    md += `- **${d.league}**: ${d.note || 'hold'}${d.flag ? ` — ⚠ ${d.flag}` : ''}\n`;
  }
  const flags = decisions.filter(d => d.flag && Object.keys(d.changes).length);
  if (flags.length) {
    md += `\n## Flags for manual review\n\n`;
    for (const d of flags) md += `- **${d.league}**: ${d.flag}\n`;
  }
  return md;
}

async function main() {
  const { getValues } = require('../src/sheets');
  const { SPREADSHEET_ID, SHEETS } = require('../src/config');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[tune] weekly-threshold-tune starting${dryRun ? ' (dry-run)' : ''}`);

  const raw = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!raw || raw.length < 2) { console.error('[tune] Performance Log empty or unreadable'); process.exit(1); }
  const rows = raw.slice(1); // drop header
  console.log(`[tune] read ${rows.length} Performance Log rows`);

  const now = new Date();
  const cut7 = new Date(now); cut7.setDate(now.getDate() - 7);
  const cut30 = new Date(now); cut30.setDate(now.getDate() - 30);
  const seg7 = buildSegments(rows, cut7);
  const seg30 = buildSegments(rows, cut30);

  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const decisions = [];
  for (const lg of LEAGUES) {
    const current = mergedThresholds(cfg, lg);
    const d = decideLeagueChange(lg, seg7[lg], seg30[lg], current);
    d.league = lg;
    decisions.push(d);
    const summary = Object.keys(d.changes).length ? JSON.stringify(d.changes) : (d.note || 'hold');
    console.log(`[tune] ${lg}: ${summary}${d.flag ? ' | FLAG: ' + d.flag : ''}`);
  }

  // Apply changes to config
  let mutated = false;
  for (const d of decisions) {
    if (!Object.keys(d.changes).length) continue;
    cfg.leagues[d.league] = { ...(cfg.leagues[d.league] || {}), ...d.changes };
    cfg.tuning_history = cfg.tuning_history || [];
    cfg.tuning_history.push({ date: dateStr, league: d.league, changes: d.changes, reason: d.reasons.join('; ') });
    mutated = true;
  }
  if (mutated) cfg.updated = dateStr;

  const review = buildReview(dateStr, seg7, seg30, decisions);

  if (dryRun) {
    console.log('\n--- REVIEW (dry-run, not written) ---\n' + review);
    console.log('--- CONFIG (dry-run, not written) ---\n' + JSON.stringify(cfg, null, 2));
    return;
  }

  if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });
  fs.writeFileSync(path.join(REVIEW_DIR, `${dateStr}.md`), review);
  if (mutated) {
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`[tune] wrote updated config + review (${dateStr})`);
  } else {
    console.log(`[tune] no threshold changes; wrote review only (${dateStr})`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[tune] FATAL:', e.message); process.exit(1); });
}

module.exports = { decideLeagueChange, buildSegments, normMarket, parseDate, finalize, mergedThresholds };
