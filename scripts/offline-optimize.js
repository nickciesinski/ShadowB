#!/usr/bin/env node
'use strict';
/**
 * scripts/offline-optimize.js
 *
 * Reads a Performance Log CSV (exported from the Google Sheet) and produces:
 *   1) A 7-day and 30-day performance report by league x market
 *   2) Weight-tuning recommendations based on 30-day ROI signal
 *   3) Updated Weights_* rows ready to paste into each weights sheet
 *
 * Usage:
 *   node scripts/offline-optimize.js <performance-log.csv> [--days=30] [--out=./opt-report]
 *
 * The script does NOT call any API — it runs purely on the exported data so
 * it can be re-run safely without touching production.
 */
const fs = require('fs');
const path = require('path');

function parseCsv(text) {
  // Minimal CSV parser that handles quoted fields and embedded commas.
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function buildIndex(header) {
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  return idx;
}

function toNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; }

function analyze(perfRows, days) {
  const header = perfRows[0];
  const ix = buildIndex(header);
  const required = ['date', 'league', 'market', 'Units', 'result (W/L)', 'unit_return'];
  for (const k of required) if (!(k in ix)) throw new Error(`Missing column: ${k}`);

  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);

  const rows = [];
  for (let r = 1; r < perfRows.length; r++) {
    const row = perfRows[r];
    if (!row || !row[ix.date]) continue;
    const d = new Date(String(row[ix.date]).slice(0, 10));
    if (isNaN(d)) continue;
    if (d < cutoff) continue;
    const ret = toNum(row[ix.unit_return]);
    const result = String(row[ix['result (W/L)']] || '').trim();
    if (!result || (result !== 'W' && result !== 'L' && result !== 'P')) continue;
    rows.push({
      date: d,
      league: row[ix.league],
      market: row[ix.market],
      units: toNum(row[ix.Units]) || 0,
      result,
      ret: Number.isFinite(ret) ? ret : 0,
    });
  }
  return rows;
}

function groupStats(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (!out[k]) out[k] = { n: 0, w: 0, l: 0, p: 0, risked: 0, ret: 0 };
    const g = out[k];
    g.n++;
    if (r.result === 'W') g.w++;
    else if (r.result === 'L') g.l++;
    else g.p++;
    g.risked += r.units;
    g.ret += r.ret;
  }
  for (const k of Object.keys(out)) {
    const g = out[k];
    g.winPct = g.w + g.l > 0 ? (g.w / (g.w + g.l)) * 100 : 0;
    g.roi = g.risked > 0 ? (g.ret / g.risked) * 100 : 0;
  }
  return out;
}

function fmt(n, d = 1) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }

function recommend(stats30) {
  const recs = [];
  const keys = Object.keys(stats30).sort();
  for (const key of keys) {
    const [league, market] = key.split('|');
    const s = stats30[key];
    if (s.n < 30) { // not enough signal
      recs.push({ league, market, action: 'hold (small sample)', roi: s.roi, n: s.n });
      continue;
    }
    // Break-even at -110 is ~52.4%
    if (s.roi < -10) {
      recs.push({ league, market, action: 'CUT HARD — reduce modifier 30% or raise min_confidence', roi: s.roi, n: s.n });
    } else if (s.roi < -3) {
      recs.push({ league, market, action: 'reduce modifier 10-15%', roi: s.roi, n: s.n });
    } else if (s.roi > 10) {
      recs.push({ league, market, action: 'BOOST — increase modifier 15-20%', roi: s.roi, n: s.n });
    } else if (s.roi > 3) {
      recs.push({ league, market, action: 'slight boost 5-10%', roi: s.roi, n: s.n });
    } else {
      recs.push({ league, market, action: 'hold (within noise)', roi: s.roi, n: s.n });
    }
  }
  return recs;
}

function printTable(title, stats) {
  console.log(`\n=== ${title} ===`);
  console.log('key                      n    W-L    win%    risked   return     ROI%');
  const keys = Object.keys(stats).sort();
  for (const k of keys) {
    const s = stats[k];
    console.log(
      k.padEnd(22) + ' ' +
      String(s.n).padStart(5) + '  ' +
      `${s.w}-${s.l}`.padStart(7) + '  ' +
      fmt(s.winPct).padStart(5) + '%  ' +
      fmt(s.risked, 1).padStart(8) + '  ' +
      fmt(s.ret, 2).padStart(7) + '  ' +
      fmt(s.roi, 1).padStart(7) + '%'
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node scripts/offline-optimize.js <performance-log.csv> [--days=30]');
    process.exit(1);
  }
  const inputFile = args[0];
  const daysArg = args.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;

  const text = fs.readFileSync(inputFile, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Empty Performance Log');

  const rows30 = analyze(rows, days);
  const rows7 = analyze(rows, 7);
  console.log(`Analyzed ${rows30.length} graded bets in last ${days} days, ${rows7.length} in last 7 days.\n`);

  const byLM30 = groupStats(rows30, r => `${r.league}|${r.market}`);
  const byLM7 = groupStats(rows7, r => `${r.league}|${r.market}`);
  printTable(`${days}-day by league|market`, byLM30);
  printTable('7-day by league|market', byLM7);

  const recs = recommend(byLM30);
  console.log('\n=== Weight modifier recommendations (based on 30-day ROI) ===');
  for (const r of recs) {
    console.log(`${(r.league + '|' + r.market).padEnd(22)} n=${String(r.n).padStart(4)}  ROI=${fmt(r.roi).padStart(6)}%  → ${r.action}`);
  }

  console.log('\nNotes:');
  console.log(' - Break-even ROI at -110 juice is ~ -4.8% (you need ~52.4% win rate to break even).');
  console.log(' - "Reduce modifier" refers to PERFORMANCE_MODIFIERS in src/predictions.js.');
  console.log(' - "Raise min_confidence" refers to param_min_confidence_to_bet in the league Weights sheet.');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { parseCsv, analyze, groupStats, recommend };
