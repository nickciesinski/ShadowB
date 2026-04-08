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
// None of these functions throw — monitoring failures must NEVER break a
// trigger. They log and return.
// =============================================================

const { appendRows, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

function isoNow() { return new Date().toISOString(); }
function prettyNow() {
  // "Wednesday, April 8 2026  5:25 AM"
  return new Date().toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
  });
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
 * API call log row. Columns: Timestamp, Endpoint, Cost Estimate, Tokens
 * Used by data-collection.js (Odds API) and can be extended to OpenAI.
 */
async function logApiCall({ endpoint, costEstimate = 0, tokens = '' }) {
  try {
    await appendRows(SPREADSHEET_ID, SHEETS.API_USAGE_LOG, [[
      isoNow(), endpoint, costEstimate, tokens,
    ]]);
  } catch (e) {
    console.warn('[monitoring] API_Usage_Log write failed:', e.message);
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
 */
function withMonitoring(name, fn) {
  return async function monitored(...args) {
    const startMs = Date.now();
    let status = 'SUCCESS';
    let error = '';
    try {
      const result = await fn(...args);
      const endMs = Date.now();
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
  refreshDashboardHeader,
  withMonitoring,
};
