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
  if (!sb) return;
  const { error } = await sb.from('performance_log').insert(rows);
  if (error) console.warn('[db] insertPerformanceRows:', error.message);
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

module.exports = {
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
};
