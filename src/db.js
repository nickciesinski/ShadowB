'use strict';
/**
 * src/db.js — Supabase data access layer
 * Provides typed helpers for all feedback-loop tables.
 * Falls back gracefully if SUPABASE_URL is not set (Sheets-only mode).
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let _client = null;

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

/** Returns true if Supabase is configured and available. */
function isEnabled() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

// ── Performance Log ─────────────────────────────────────────────

async function insertPerformanceRows(rows) {
  const sb = getClient();
  if (!sb) return { ok: false, inserted: 0, reason: 'supabase_not_configured' };
  const { error } = await sb.from('performance_log').insert(rows);
  if (error) {
    // 2026-06-03: previously this only logged a warning and returned undefined,
    // which let callers print "Dual-wrote N picks" while inserts silently failed
    // for 41 days (missing approval_status column). Now we return an explicit
    // failure object the caller can check, and log an alarming message so the
    // failure is visible at glance.
    console.error(`[db] insertPerformanceRows FAILED for ${rows.length} rows:`, error.message);
    return { ok: false, inserted: 0, reason: error.message };
  }
  return { ok: true, inserted: rows.length };
}

async function getPerformanceStats({ days = 30, league, market } = {}) {
  const sb = getClient();
  if (!sb) return null;
  let q = sb.from('v_modifier_inputs').select('*');
  if (league) q = q.eq('league', league);
  if (market) q = q.eq('market', market);
  const { data, error } = await q;
  if (error) { console.warn('[db] getPerformanceStats:', error.message); return null; }
  return data;
}

// ── Performance Modifiers ───────────────────────────────────────

async function readModifiers() {
  const sb = getClient();
  if (!sb) return {};
  const { data, error } = await sb.from('performance_modifiers').select('*');
  if (error) { console.warn('[db] readModifiers:', error.message); return {}; }
  const map = {};
  for (const row of (data || [])) {
    map[`${row.league}|${row.market}`] = row.modifier;
  }
  return map;
}

async function upsertModifier({ league, market, modifier, sample_size, win_rate, roi }) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.from('performance_modifiers').upsert(
    { league, market, modifier, sample_size, win_rate, roi, updated_at: new Date().toISOString() },
    { onConflict: 'league,market' }
  );
  if (error) console.warn('[db] upsertModifier:', error.message);
}

// ── Prop Performance ────────────────────────────────────────────

async function insertPropPerformance(rows) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.from('prop_performance').insert(rows);
  if (error) console.warn('[db] insertPropPerformance:', error.message);
}

async function getPropWeightInputs() {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.from('v_prop_weight_inputs').select('*');
  if (error) { console.warn('[db] getPropWeightInputs:', error.message); return null; }
  return data;
}

// ── Prop Weights ────────────────────────────────────────────────

async function readPropWeights(league) {
  const sb = getClient();
  if (!sb) return {};
  let q = sb.from('prop_weights').select('*');
  if (league) q = q.eq('league', league);
  const { data, error } = await q;
  if (error) { console.warn('[db] readPropWeights:', error.message); return {}; }
  const map = {};
  for (const row of (data || [])) {
    map[row.market] = row.weight;
  }
  return map;
}

async function upsertPropWeight({ league, market, weight, sample_size, clv_hit_rate, avg_edge }) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.from('prop_weights').upsert(
    { league, market, weight, sample_size, clv_hit_rate, avg_edge, updated_at: new Date().toISOString() },
    { onConflict: 'league,market' }
  );
  if (error) console.warn('[db] upsertPropWeight:', error.message);
}

// ── CLV Snapshots ───────────────────────────────────────────────

async function insertCLVSnapshot(rows) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.from('clv_snapshots').insert(rows);
  if (error) console.warn('[db] insertCLVSnapshot:', error.message);
}

// ── Prop Status ─────────────────────────────────────────────────

async function insertPropStatus(rows) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.from('prop_status').insert(rows);
  if (error) console.warn('[db] insertPropStatus:', error.message);
}

// ── Performance Grading ─────────────────────────────────────

/**
 * Batch-update graded results into performance_log.
 * Each row is matched by date + league + game + market + pick.
 * @param {Array<Object>} gradedRows - [{date, league, game, market, pick, result}]
 */
async function updatePerformanceResults(gradedRows) {
  const sb = getClient();
  if (!sb || !gradedRows || gradedRows.length === 0) return;

  let updated = 0;
  let failed = 0;
  for (const row of gradedRows) {
    const update = {
      result: row.result,
      prediction_correct: row.result === 'W' ? true : row.result === 'L' ? false : null,
    };
    // 2026-07-07: unit_return was being computed in predictions.js but never
    // passed through to this update, so it stayed null in Supabase forever —
    // any ROI calc reading performance_log directly (not the Sheet) silently
    // saw 0% ROI regardless of actual performance. Write it when present.
    if (row.unit_return != null) update.unit_return = row.unit_return;
    const { error } = await sb.from('performance_log')
      .update(update)
      .eq('date', row.date)
      .eq('league', row.league)
      .eq('game', row.game)
      .eq('market', row.market)
      .eq('pick', row.pick);

    if (error) {
      failed++;
      if (failed <= 3) console.warn(`[db] updatePerformanceResults: ${error.message}`);
    } else {
      updated++;
    }
  }
  console.log(`[db] Performance grading sync: ${updated} updated, ${failed} failed`);
}

// ── Trigger Log ─────────────────────────────────────────────────

/**
 * Get trigger runs from the last N hours. Used by health check as fallback
 * when Sheets Trigger_Monitor is unavailable (cell limit).
 */
async function getRecentTriggerRuns(hours = 24) {
  const sb = getClient();
  if (!sb) return null;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb.from('trigger_log')
    .select('trigger_name, status, start_time, end_time, duration_sec, error_message')
    .gte('start_time', since)
    .order('start_time', { ascending: false });
  if (error) { console.warn('[db] getRecentTriggerRuns:', error.message); return null; }
  return data;
}

async function logTrigger({ trigger_name, status, start_time, end_time, duration_sec, records_processed, error_message, memory_mb }) {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.from('trigger_log').insert({
    trigger_name, status, start_time, end_time, duration_sec,
    records_processed, error_message, memory_mb,
  });
  if (error) console.warn('[db] logTrigger:', error.message);
}

// ── Confidence Calibration ──────────────────────────────────────

async function getConfidenceCalibration() {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.from('v_confidence_calibration').select('*');
  if (error) { console.warn('[db] getConfidenceCalibration:', error.message); return null; }
  return data;
}

/**
 * Read performance_log rows since a given date, bounded and paginated so we
 * never silently hit PostgREST's default ~1000-row cap on a table this size
 * (106k+ rows and growing). Ordered oldest-first isn't required by callers,
 * so we just page through everything >= sinceDateISO.
 *
 * 2026-07-07: added because scripts/weekly-threshold-tune.js reads the
 * Google Sheet's Performance Log directly (dataStore mode is 'sheet'), and
 * that tab is subject to a read-modify-write race between logPicksToPerformanceLog
 * (full clear+rewrite on every trigger4 run) and gradePerformanceLog's in-place
 * grade write — the two aren't coordinated, so a same-day trigger4 run can
 * silently revert freshly-graded W/L/P cells back to blank. Supabase writes
 * are row-level (insert / targeted update), so it isn't exposed to that race
 * and is the more reliable source for anything read-only like the tuner.
 *
 * @param {string} sinceDateISO - 'YYYY-MM-DD', inclusive lower bound on `date`
 * @returns {Promise<Array<Object>|null>} raw performance_log rows, or null if
 *   Supabase isn't configured / the query failed (callers should fall back).
 */
async function getRecentPerformanceLog(sinceDateISO) {
  const sb = getClient();
  if (!sb) return null;
  const PAGE = 1000;
  let all = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.from('performance_log')
      .select('date, league, game, market, pick, line, odds, confidence, final_units, result, unit_return, approval_status, clv_opening_prob, clv_closing_prob')
      .gte('date', sinceDateISO)
      .order('date', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.warn('[db] getRecentPerformanceLog:', error.message);
      return all.length ? all : null;
    }
    all = all.concat(data || []);
    if (!data || data.length < PAGE) break; // last page
    if (offset > 200000) break; // sanity guard, should never trigger
  }
  return all;
}

// ── Raw query for bootstrap/migration ───────────────────────────

async function rawSelect(table, { columns = '*', filters = {}, limit, orderBy } = {}) {
  const sb = getClient();
  if (!sb) return null;
  let q = sb.from(table).select(columns);
  for (const [col, val] of Object.entries(filters)) {
    q = q.eq(col, val);
  }
  if (orderBy) q = q.order(orderBy.column, { ascending: orderBy.asc ?? false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) { console.warn(`[db] rawSelect(${table}):`, error.message); return null; }
  return data;
}

// ── Prediction Features Log ─────────────────────────────────────

async function insertPredictionFeatures(rows) {
  const sb = getClient();
  if (!sb) return;
  // Batch in chunks of 50 to avoid payload limits
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { error } = await sb.from('prediction_features').insert(chunk);
    if (error) console.warn('[db] insertPredictionFeatures:', error.message);
  }
}


// ── Cross-run Google OAuth token cache ──────────────────────────
// Stored in sheet_snapshots under a reserved entity so no migration is needed.
// Lets one successful token fetch be reused by other runs for ~1h, so they don't
// each have to fight the intermittently-failing Google token endpoint. Supabase
// is reachable even when Google's token endpoint is dropping connections.
const AUTH_TOKEN_ENTITY = '__google_oauth_token__';

async function setCachedAccessToken(access_token, expiry_date) {
  const sb = getClient();
  if (!sb) return { ok: false };
  const { error } = await sb.from('sheet_snapshots').insert({ entity: AUTH_TOKEN_ENTITY, rows: { access_token, expiry_date } });
  if (error) { console.warn('[db] setCachedAccessToken failed:', error.message); return { ok: false }; }
  return { ok: true };
}

async function getCachedAccessToken() {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.from('sheet_snapshots')
    .select('rows').eq('entity', AUTH_TOKEN_ENTITY).order('captured_at', { ascending: false }).limit(1);
  if (error || !data || !data[0]) return null;
  return data[0].rows; // { access_token, expiry_date }
}

// ── Sheet-exit staging snapshots (Category B external data) ─────
async function insertSnapshot(entity, rows) {
  const sb = getClient();
  if (!sb) return { ok: false, reason: 'supabase_not_configured' };
  const { error } = await sb.from('sheet_snapshots').insert({ entity, rows });
  if (error) { console.error('[db] insertSnapshot FAILED', entity + ':', error.message); return { ok: false, reason: error.message }; }
  return { ok: true };
}

async function getSnapshotInfo(entity) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.from('sheet_snapshots')
    .select('captured_at').eq('entity', entity).order('captured_at', { ascending: false }).limit(1);
  if (error || !data || !data[0]) return null;
  return { capturedAt: data[0].captured_at };
}

async function getLatestSnapshot(entity) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.from('sheet_snapshots')
    .select('rows').eq('entity', entity).order('captured_at', { ascending: false }).limit(1);
  if (error) { console.warn('[db] getLatestSnapshot', entity + ':', error.message); return null; }
  return (data && data[0]) ? data[0].rows : null;
}

module.exports = {
  updatePerformanceResults,
  getRecentTriggerRuns,
  isEnabled,
  getClient,
  // Performance
  insertPerformanceRows,
  getPerformanceStats,
  // Modifiers
  readModifiers,
  upsertModifier,
  // Props
  insertPropPerformance,
  getPropWeightInputs,
  // Prop weights
  readPropWeights,
  upsertPropWeight,
  // CLV
  insertCLVSnapshot,
  // Status
  insertPropStatus,
  // Triggers
  logTrigger,
  // Calibration
  getConfidenceCalibration,
  // Raw
  rawSelect,
  getRecentPerformanceLog,
  // Prediction features
  insertPredictionFeatures,
  // Sheet-exit staging snapshots
  insertSnapshot,
  getLatestSnapshot,
  getSnapshotInfo,
  setCachedAccessToken,
  getCachedAccessToken,
};