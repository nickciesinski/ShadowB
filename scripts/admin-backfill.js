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

  return {
    date:    exactDate   >= 0 ? exactDate   : findCol(h => h.includes('date'), 0),
    league:  exactLeague >= 0 ? exactLeague : findCol(h => h.includes('league') || h.includes('sport'), 1),
    market:  exactMarket >= 0 ? exactMarket : findCol(h => h.includes('market') || h.includes('bet_type') || h.includes('bettype'), 6),
    away:    findCol(h => h.includes('away'), 3),
    home:    findCol(h => h.includes('home'), 4),
    pick:    exactPick   >= 0 ? exactPick   : findCol(h => h === 'pick' || h.startsWith('pick '), 7),
    line:    exactLine   >= 0 ? exactLine   : findCol(h => h === 'line' || h.includes('line ('), 8),
    odds:    exactOdds   >= 0 ? exactOdds
            : findCol(h => /\bodds\b/.test(h) && !h.includes('closing') && !h.includes('opening') && !h.includes('clv'), 9),
    units:   findCol(h => h === 'units' || h === 'final_units' || (h.includes('unit') && !h.includes('return')), 10),
    conf:    findCol(h => h.includes('confidence') || h === 'conf', 11),
    result:  exactResult >= 0 ? exactResult : findCol(h => h === 'result' || h.startsWith('result ') || /^w\/l/.test(h), 16),
    ret:     findCol(h => h.includes('return') || h === 'unit_return', 17),
    approval: findCol(h => h.includes('approval_status') || h === 'approval', 21),
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

  const raw = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
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
