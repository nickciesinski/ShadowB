'use strict';
// =============================================================
// src/snapshot-sink.js
//
// Snapshot-first persistence for sheets-exit dual-write entities
// (scheduleContext, injuries, yesterdayResults, playerTiers, …).
//
// The durable Supabase snapshot is the migration shadow the sheets-exit health
// check reads for staleness, so it MUST be written before the authoritative
// Google Sheet — otherwise a Sheet failure (OAuth "Premature close", full
// workbook) throws first and leaves the shadow stale for days. The Sheet write
// still throws loudly on failure (we never silently empty it). All I/O injected,
// so this is offline-testable. (gameOdds uses the dedicated src/odds-sink.js,
// which also archives to Historical_Odds.)
// =============================================================

/**
 * @param {Object} opts {
 *   entity, rows, mode, insertSnapshot, writeSheet, log?
 * }
 * @returns {Promise<{snapshotOk:boolean}>}
 */
async function persistSnapshotFirst({ entity, rows, mode, insertSnapshot, writeSheet, log = console }) {
  // 1) Durable Supabase snapshot FIRST (guarded, independent of the Sheet).
  let snapshotOk = false;
  if (mode !== 'sheet') {
    try {
      await insertSnapshot(entity, rows);
      snapshotOk = true;
    } catch (e) {
      log.warn(`[snapshot] ${entity} snapshot dual-write failed:`, e.message);
    }
  }

  // 2) Authoritative Sheet write — may throw (alerts); snapshot is already safe.
  if (writeSheet) await writeSheet();

  return { snapshotOk };
}

module.exports = { persistSnapshotFirst };
