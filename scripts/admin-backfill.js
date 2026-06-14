#!/usr/bin/env node
'use strict';
/**
 * scripts/admin-backfill.js
 *
 * Restore lost rows in Supabase performance_log from the Sheets Performance
 * Log master copy. Use case: the 2026-04-24 to 2026-06-04 dual-write outage
 * (root cause: missing approval_status column) left a 41-day hole in
 * Supabase. The Sheets log retained every row. This script reads the Sheet,
 * filters to a date range, maps every column the writer originally produced
 * onto the new Supabase schema, and inserts in batches with dedup against
 * the existing Supabase contents.
 *
 * Usage:
 *   node scripts/admin-backfill.js --from 2026-04-24 --to 2026-06-04
 *   node scripts/admin-backfill.js --from 2026-04-24 --to 2026-06-04 --dry-run
 *   node scripts/admin-backfill.js --from 2026-04-24 --to 2026-06-04 --limit 50
 *
 * Flags:
 *   --from YYYY-MM-DD     Inclusive start (required)
 *   --to   YYYY-MM-DD     Inclusive end   (required)
 *   --dry-run             Print what would happen, no writes
 *   --limit N             Cap insertions at N rows (for testing)
 *   --no-dedup            Skip the existing-row check (use only on empty windows)
 *
 * Safety:
 *   - Dedup compares (date, league, game, market, pick) tuples against Supabase
 *     and skips any matches. Safe to re-run.
 *   - Field mapping is permissive — missing source columns become null, never
 *     causing the insert to fail.
 *   - Uses the same layered column detection pattern as calibration.js so the
 *     Sheet header row doesn't have to match exact lowercase strings.
 */

const db = require('../src/db');
const { getValues } = require('../src/sheets');
const dataStore = require('../src/data-store');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
function bool(name) {
  return args.includes(`--${name}`);
}

const FROM = flag('from');
const TO   = flag('to');
const DRY_RUN = bool('dry-run');
const LIMIT = parseInt(flag('limit')) || Infinity;
const NO_DEDUP = bool('no-dedup');

if (!FROM || !TO || !/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error('Required: --from YYYY-MM-DD --to YYYY-MM-DD');
  process.exit(2);
}

function resolveColumns(headers) {
  function findCol(predicate, fallback) {
    const i = headers.findIndex(predicate);
    return i >= 0 ? i : fallback;
  }
  const exactDate    = headers.indexOf('date');
  const exactLeague  = headers.indexOf('league');
  const exactMarket  = headers.indexOf('market');
  const exactPick    = headers.indexOf('pick');
  const exactLine    = headers.indexOf('line');
  const exactOdds    = headers.indexOf('odds');
  const exactResult  = headers.indexOf('result');

  // Strict-match-or-positional resolver: try exact / starts-with first;
  // fall back to the known hardcoded writer position if no clean match.
  // The previous version used loose .includes which matched cells like
  // weights_snapshot (col 18) when its header text happened to contain
  // substrings like "home" or "conf", corrupting away/home/units/conf
  // resolution and breaking dedup.
  function strictOrPos(predicate, pos) {
    const i = headers.findIndex(predicate);
    return i >= 0 ? i : pos;
  }
  return {
    date:    exactDate   >= 0 ? exactDate   : strictOrPos(h => h === 'date' || h.startsWith('date '), 0),
    league:  exactLeague >= 0 ? exactLeague : strictOrPos(h => h === 'league' || h === 'sport', 1),
    market:  exactMarket >= 0 ? exactMarket : strictOrPos(h => h === 'market' || h === 'bet_type' || h === 'bettype', 6),
    away:    strictOrPos(h => h === 'away' || h === 'awayteam' || h === 'away_team' || h === 'away team', 3),
    home:    strictOrPos(h => h === 'home' || h === 'hometeam' || h === 'home_team' || h === 'home team', 4),
    pick:    exactPick   >= 0 ? exactPick   : strictOrPos(h => h === 'pick' || h.startsWith('pick '), 7),
    line:    exactLine   >= 0 ? exactLine   : strictOrPos(h => h === 'line' || h.startsWith('line '), 8),
    odds:    exactOdds   >= 0 ? exactOdds
            : strictOrPos(h => h === 'odds' || h === 'american_odds' || h === 'american odds', 9),
    units:   strictOrPos(h => h === 'units' || h === 'final_units' || h === 'final units' || h === 'stake', 10),
    conf:    strictOrPos(h => h === 'confidence' || h === 'conf', 11),
    result:  exactResult >= 0 ? exactResult : strictOrPos(h => h === 'result' || h === 'w/l' || h === 'w/l/p', 16),
    ret:     strictOrPos(h => h === 'unit_return' || h === 'unit return' || h === 'return' || h === 'units_returned', 17),
    approval: strictOrPos(h => h === 'approval_status' || h === 'approval status' || h === 'approval', 21),
  };
}

function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) {
    const [, mm, dd, yyyy] = m1;
    return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function parseConfidence(v) {
  if (v == null) return null;
  const s = String(v).replace('%', '').trim();
  const n = parseInt(s);
  return Number.isFinite(n) ? n : null;
}
function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function intv(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v);
  return Number.isFinite(n) ? n : null;
}

async function loadExistingKeys(from, to) {
  if (NO_DEDUP) return new Set();
  console.log(`[backfill] Loading existing Supabase rows ${from} -> ${to} for dedup...`);
  const sb = db.getClient();
  const keys = new Set();
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('performance_log')
      .select('date, league, game, market, pick')
      .gte('date', from)
      .lte('date', to)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error('[backfill] Dedup query failed:', error.message);
      throw error;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      keys.add(`${r.date}|${r.league}|${r.game}|${r.market}|${r.pick}`);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`[backfill] Found ${keys.size} existing rows in window`);
  return keys;
}

(async () => {
  console.log('=== admin-backfill starting ===');
  console.log(`FROM=${FROM} TO=${TO} DRY_RUN=${DRY_RUN} LIMIT=${LIMIT} NO_DEDUP=${NO_DEDUP}`);
  if (!db.isEnabled()) {
    console.error('[backfill] Supabase not configured - abort');
    process.exit(1);
  }

  const raw = await dataStore.read('performanceRows');
  if (!raw || raw.length < 2) {
    console.error('[backfill] Performance Log empty in Sheets - nothing to backfill');
    process.exit(1);
  }

  const headers = raw[0].map(h => String(h).trim().toLowerCase());
  const cols = resolveColumns(headers);
  console.log('[backfill] Resolved columns:', JSON.stringify(cols));

  const existing = await loadExistingKeys(FROM, TO);

  let scanned = 0, inWindow = 0, dedup = 0, malformed = 0;
  const prepared = [];

  for (let i = 1; i < raw.length; i++) {
    scanned++;
    const r = raw[i];
    const isoDate = toIsoDate(r[cols.date]);
    if (!isoDate) { malformed++; continue; }
    if (isoDate < FROM || isoDate > TO) continue;
    inWindow++;

    const league = String(r[cols.league] || '').trim();
    const away   = String(r[cols.away]   || '').trim();
    const home   = String(r[cols.home]   || '').trim();
    const market = String(r[cols.market] || '').trim();
    const pick   = String(r[cols.pick]   || '').trim();
    const game   = `${away} @ ${home}`;

    const key = `${isoDate}|${league}|${game}|${market}|${pick}`;
    if (existing.has(key)) { dedup++; continue; }

    const result = (r[cols.result] || '').toString().trim().toUpperCase() || null;
    const approval = (r[cols.approval] || 'tracking_only').toString().trim() || 'tracking_only';

    prepared.push({
      date: isoDate,
      league,
      game,
      market,
      pick,
      line: num(r[cols.line]),
      odds: intv(r[cols.odds]),
      confidence: parseConfidence(r[cols.conf]),
      final_units: num(r[cols.units]) ?? 0,
      modifier: 1.0,
      trigger_name: `backfill_${league}`,
      approval_status: ['approved','tracking_only'].includes(approval) ? approval : 'tracking_only',
      predicted_prob: null,
      market_prob: null,
      edge_driver: null,
      pick_purpose: approval === 'approved' ? 'bet' : 'tracking',
      result: ['W','L','P'].includes(result) ? result : null,
      prediction_correct: result === 'W' ? true : result === 'L' ? false : null,
      unit_return: num(r[cols.ret]),
    });

    if (prepared.length >= LIMIT) break;
  }

  console.log(`[backfill] Scanned ${scanned} sheet rows, ${inWindow} in window`);
  console.log(`[backfill] ${dedup} already in Supabase (skipped)`);
  console.log(`[backfill] ${malformed} malformed dates (skipped)`);
  console.log(`[backfill] ${prepared.length} ready to insert`);

  const byLeague = {};
  const byResult = { W: 0, L: 0, P: 0, null: 0 };
  for (const row of prepared) {
    byLeague[row.league] = (byLeague[row.league] || 0) + 1;
    byResult[row.result || 'null']++;
  }
  console.log(`[backfill] By league:`, JSON.stringify(byLeague));
  console.log(`[backfill] By result:`, JSON.stringify(byResult));

  if (prepared.length === 0) {
    console.log('[backfill] Nothing to insert. Exiting.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('[backfill] DRY_RUN - showing first 3 prepared rows then exiting:');
    for (const row of prepared.slice(0, 3)) console.log(JSON.stringify(row, null, 2));
    process.exit(0);
  }

  const BATCH = 500;
  let totalInserted = 0;
  for (let i = 0; i < prepared.length; i += BATCH) {
    const batch = prepared.slice(i, i + BATCH);
    const res = await db.insertPerformanceRows(batch);
    if (res && res.ok) {
      totalInserted += res.inserted;
      console.log(`[backfill] Inserted batch of ${res.inserted} (cumulative ${totalInserted})`);
    } else {
      console.error(`[backfill] Batch insert FAILED at offset ${i}: ${res && res.reason}`);
      console.error('[backfill] Stopping. Re-run after addressing the schema/auth issue.');
      process.exit(1);
    }
  }

  console.log(`[backfill] Done. Inserted ${totalInserted} rows into Supabase performance_log.`);
  console.log('[backfill] Next nightly trigger14 will use these rows for the 30-day modifier window.');
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
