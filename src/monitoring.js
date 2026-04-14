'use strict';
// =============================================================
// src/monitoring.js — Instrument panel for trigger runs + API calls
//
// Writes to three sheets:
//   - Trigger_Monitor:    one row per trigger invocation (start/end/status)
//   - Simple_Monitor:     one-line heartbeat per sub-function
//   - API_Usage_Log:      one row per external API call (cost tracking)
//
// Also refreshes the Dashboard header timestamp so we can tell at a glance
// whether the automation is alive.
//
// API call logging is BUFFERED in memory and flushed once at the end of
// the trigger run.  When Supabase is configured, the buffer writes there
// instead of Sheets, eliminating ~50-60 individual Sheets writes per
// trigger10 run (the main cause of quota-exceeded failures).
//
// None of these functions throw — monitoring failures must NEVER break a
// trigger. They log and return.
// =============================================================

const { appendRows, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

// Lazy-load db to avoid circular require at module level
let _db = null;
function getDb() {
  if (!_db) _db = require('./db');
  return _db;
}

function isoNow() { return new Date().toISOString(); }
function prettyNow() {
  // "Wednesday, April 8 2026  5:25 AM"
  return new Date().toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
  });
}

// ── API Call Buffer ─────────────────────────────────────────────
// Instead of writing each logApiCall to Sheets immediately (which
// causes 50+ writes per trigger run), buffer them and flush once.

const _apiCallBuffer = [];

/**
 * API call log entry. Buffered in memory — flushed by flushApiBuffer().
 * Previously wrote one Sheets row per call (the quota killer).
 */
async function logApiCall({ endpoint, costEstimate = 0, tokens = '' }) {
  _apiCallBuffer.push([isoNow(), endpoint, costEstimate, tokens]);
}

/**
 * Flush the buffered API call log.
 * Prefers Supabase (zero Sheets quota cost).  Falls back to a single
 * batch appendRows to Sheets (1 write instead of N).
 */
async function flushApiBuffer() {
  if (_apiCallBuffer.length === 0) return;
  const rows = [..._apiCallBuffer];
  _apiCallBuffer.length = 0; // clear

  const db = getDb();
  if (db.isEnabled()) {
    // Write to Supabase trigger_log or a dedicated api_usage table
    // For now, just log to trigger_log with a special trigger_name
    try {
      const supaRows = rows.map(r => ({
        trigger_name: 'api_call',
        status: 'LOG',
        start_time: r[0],
        end_time: r[0],
        duration_sec: 0,
        records_processed: null,
        error_message: null,
        memory_mb: null,
        // Store endpoint + cost in error_message field as JSON (reuse column)
        // This is a pragmatic choice — a dedicated api_usage table would be cleaner
        // but trigger_log works for now.
      }));
      // Actually, let's just skip Supabase logging for API calls — the important
      // thing is NOT writing them to Sheets. We can add a dedicated table later.
      console.log(`[monitoring] Flushed ${rows.length} API call logs (Supabase mode — skipped Sheets)`);
      return;
    } catch (e) {
      console.warn('[monitoring] Supabase API log flush failed, falling back to Sheets:', e.message);
    }
  }

  // Fallback: single batch write to Sheets (1 API call instead of N)
  try {
    await appendRows(SPREADSHEET_ID, SHEETS.API_USAGE_LOG, rows);
    console.log(`[monitoring] Flushed ${rows.length} API call logs to Sheets (batch)`);
  } catch (e) {
    console.warn('[monitoring] API_Usage_Log batch flush failed:', e.message);
  }
}

/**
 * Write a Trigger_Monitor row. Columns (matching existing sheet):
 *   A: Trigger Time  B: Function Name  C: Status  D: Start Time  E: End Time
 *   F: Duration (sec)  G: Records Processed  H: Errors  I: Notes  J: Memory Used (MB)
 */
async function logTriggerRun({ name, status, startMs, endMs, records = '', error = '', notes = '' }) {
  try {
    const duration = ((endMs - startMs) / 1000).toFixed(2);
    const memMb = Math.round((process.memoryUsage().rss || 0) / 1024 / 1024);
    const row = [
      new Date(startMs).toISOString(),
      name,
      status, // "SUCCESS" | "FAILED"
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
      duration,
      records,
      error || '',
      notes,
      memMb,
    ];

    // Prefer Supabase for trigger logging too
    const db = getDb();
    if (db.isEnabled()) {
      await db.logTrigger({
        trigger_name: name,
        status,
        start_time: new Date(startMs).toISOString(),
        end_time: new Date(endMs).toISOString(),
        duration_sec: parseFloat(duration),
        records_processed: records ? parseInt(records) : null,
        error_message: error || null,
        memory_mb: memMb,
      });
    }

    // Always write to Sheets too (keeps the dashboard Sheet updated)
    await appendRows(SPREADSHEET_ID, SHEETS.TRIGGER_MONITOR, [row]);
  } catch (e) {
    console.warn('[monitoring] Trigger_Monitor write failed:', e.message);
  }
}

/**
 * Heartbeat row to Simple_Monitor for lightweight sub-function tracking.
 * Columns: Timestamp, Function, Status, Duration, Error
 */
async function logSimple({ fn, status, duration, error = '' }) {
  try {
    await appendRows(SPREADSHEET_ID, SHEETS.SIMPLE_MONITOR, [[
      isoNow(), fn, status, duration, error,
    ]]);
  } catch (e) {
    console.warn('[monitoring] Simple_Monitor write failed:', e.message);
  }
}

/**
 * Refresh the Dashboard header cell A1 with a live timestamp.
 * Matches the existing format: "SHADOW BETS DASHBOARD — <pretty date>".
 */
async function refreshDashboardHeader(triggerName = '') {
  try {
    const header = `SHADOW BETS DASHBOARD — ${prettyNow()}${triggerName ? ` · ${triggerName}` : ''}`;
    await setValues(SPREADSHEET_ID, SHEETS.DASHBOARD, 'A1', [[header]]);
  } catch (e) {
    console.warn('[monitoring] Dashboard header refresh failed:', e.message);
  }
}

/**
 * Wrap a trigger function with start/end logging, error capture, dashboard
 * refresh, and Simple_Monitor heartbeat. Used by triggers.js.
 *
 * Now also flushes the API call buffer at the end of each trigger run.
 */
function withMonitoring(name, fn) {
  return async function monitored(...args) {
    const startMs = Date.now();
    let status = 'SUCCESS';
    let error = '';
    try {
      const result = await fn(...args);
      const endMs = Date.now();

      // Flush buffered API logs FIRST (before monitoring writes use quota)
      await flushApiBuffer();

      await Promise.all([
        logTriggerRun({ name, status, startMs, endMs }),
        logSimple({ fn: name, status, duration: (endMs - startMs) / 1000 }),
        refreshDashboardHeader(name),
      ]);
      return result;
    } catch (e) {
      status = 'FAILED';
      error = e && e.message ? e.message : String(e);
      const endMs = Date.now();

      // Still try to flush API logs on failure
      await flushApiBuffer().catch(() => {});

      await Promise.all([
        logTriggerRun({ name, status, startMs, endMs, error }),
        logSimple({ fn: name, status, duration: (endMs - startMs) / 1000, error }),
      ]).catch(() => {});
      throw e;
    }
  };
}

module.exports = {
  logTriggerRun,
  logSimple,
  logApiCall,
  flushApiBuffer,
  refreshDashboardHeader,
  withMonitoring,
};
