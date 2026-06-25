'use strict';
// =============================================================
// src/trigger-log.js
//
// Pure, dependency-free writer for a single trigger-run record.
//
// Supabase `trigger_log` is the PRIMARY, durable record — the daily health check
// (src/trigger-health.js) reads it. The Google-Sheet `Trigger_Monitor` mirror is
// best-effort convenience for the dashboard and is EXPECTED to fail silently once
// the workbook nears the 10M-cell cap.
//
// The two writes are isolated so a full/over-cap sheet can never block or mask the
// Supabase write — that masking is exactly what produced the false "9 triggers
// missing" alert. All I/O is injected (db, appendRows), so this is offline-testable.
// =============================================================

// Build the 10-column Trigger_Monitor row (matches the existing sheet layout):
//   A:Trigger Time B:Function C:Status D:Start E:End F:Duration(s)
//   G:Records H:Errors I:Notes J:Memory(MB)
function buildTriggerRow({ name, status, startMs, endMs, records = '', error = '', notes = '', memMb = 0 }) {
  const duration = ((endMs - startMs) / 1000).toFixed(2);
  return [
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
}

/**
 * Write one trigger-run record. Supabase first (primary), Sheet second
 * (best-effort) — each guarded independently.
 * @param {Object} payload  { name, status, startMs, endMs, records?, error?, notes?, memMb? }
 * @param {Object} deps     { db, appendRows, spreadsheetId, sheet, log? }
 * @returns {Promise<{supabaseOk:boolean, sheetOk:boolean}>}
 */
async function writeTriggerLog(payload, deps) {
  const { db, appendRows, spreadsheetId, sheet, log = console } = deps;
  const { name, status, startMs, endMs, records = '', error = '', notes = '', memMb = 0 } = payload;
  const duration = ((endMs - startMs) / 1000).toFixed(2);
  const row = buildTriggerRow({ name, status, startMs, endMs, records, error, notes, memMb });

  let supabaseOk = false;
  if (db && typeof db.isEnabled === 'function' && db.isEnabled()) {
    try {
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
      supabaseOk = true;
    } catch (e) {
      log.warn('[monitoring] Supabase trigger_log write failed:', e.message);
    }
  }

  let sheetOk = false;
  try {
    await appendRows(spreadsheetId, sheet, [row]);
    sheetOk = true;
  } catch (e) {
    log.warn('[monitoring] Trigger_Monitor sheet write failed (Supabase primary still has it):', e.message);
  }

  return { supabaseOk, sheetOk };
}

module.exports = { buildTriggerRow, writeTriggerLog };
