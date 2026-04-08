#!/usr/bin/env node
'use strict';
/**
 * scripts/apply-weights.js
 *
 * Reads CSVs from weights/Weights_<LEAGUE>.csv and pushes each one into the
 * matching Weights_* tab in the live Google Sheet. Meant to be run manually
 * (locally or via `workflow_dispatch`) after you've reviewed new weights.
 *
 * CSV schema (header required):
 *   market,key,weight
 *   ,param_min_units_to_bet,0.01
 *   moneyline,run_differential_diff,0.85
 *   ...
 *
 * Usage:
 *   node scripts/apply-weights.js              # push all 4 leagues
 *   node scripts/apply-weights.js MLB NBA      # push only the named leagues
 *   node scripts/apply-weights.js --dry-run    # print what would be written
 */
const fs = require('fs');
const path = require('path');
const { writeWeights, sheetForLeague } = require('../src/weights');

const LEAGUES = ['MLB', 'NBA', 'NHL', 'NFL'];

function parseCsv(text) {
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
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

async function applyLeague(league, { dryRun }) {
  const csvPath = path.join(__dirname, '..', 'weights', `Weights_${league}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.warn(`[apply-weights] Skip ${league}: ${csvPath} not found`);
    return;
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.warn(`[apply-weights] Skip ${league}: empty CSV`);
    return;
  }
  // Drop header row if present
  const header = rows[0].map(s => String(s).trim().toLowerCase());
  const hasHeader = header[0] === 'market' && header[1] === 'key';
  const dataRows = (hasHeader ? rows.slice(1) : rows).map(r => [
    String(r[0] || '').trim(),
    String(r[1] || '').trim(),
    Number.isFinite(parseFloat(r[2])) ? parseFloat(r[2]) : 0,
  ]).filter(r => r[1]); // must have a key

  const target = sheetForLeague(league);
  console.log(`[apply-weights] ${league} → ${target}: ${dataRows.length} rows`);
  if (dryRun) {
    for (const r of dataRows) console.log('  ', r.join(' | '));
    return;
  }
  await writeWeights(dataRows, target);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const picked = args.filter(a => !a.startsWith('--')).map(a => a.toUpperCase());
  const leagues = picked.length ? picked : LEAGUES;
  for (const L of leagues) {
    if (!LEAGUES.includes(L)) { console.warn(`Unknown league: ${L}`); continue; }
    try { await applyLeague(L, { dryRun }); }
    catch (e) { console.error(`[apply-weights] ${L} FAILED:`, e.message); process.exitCode = 1; }
  }
}

if (require.main === module) { main(); }
