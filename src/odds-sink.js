'use strict';
// =============================================================
// src/odds-sink.js
//
// Persist a freshly-built gameOdds table to its sinks. The Supabase snapshot is
// the DURABLE migration shadow (the sheets-exit health check reads its
// captured_at for staleness), so it must be written FIRST and independently —
// never gated behind the Google-Sheet write.
//
// Before this fix, the order was sheet-clear -> sheet-write -> snapshot, so any
// Sheet failure (e.g. the OAuth token "Premature close" outage) threw before the
// snapshot ran, leaving the shadow stale for days ("Snapshot is stale (53h old)").
//
// The authoritative Sheet write still throws loudly on failure (we must not
// silently leave it empty), but by then the snapshot is already safe. All I/O is
// injected, so this is offline-testable.
// =============================================================

/**
 * @param {Array<Array>} rows  full gameOdds table incl. header row
 * @param {Object} deps {
 *   mode, insertSnapshot, clearSheet, setValues, appendRows,
 *   spreadsheetId, gameOddsSheet, historicalSheet, log?
 * }
 * @returns {Promise<{snapshotOk:boolean}>}
 */
async function persistGameOdds(rows, deps) {
  const {
    mode, insertSnapshot, clearSheet, setValues, appendRows,
    spreadsheetId, gameOddsSheet, historicalSheet, log = console,
  } = deps;

  // 1) Durable Supabase snapshot FIRST (guarded) — independent of the Sheet.
  let snapshotOk = false;
  if (mode !== 'sheet') {
    try {
      await insertSnapshot('gameOdds', rows);
      snapshotOk = true;
    } catch (e) {
      log.warn('[data-collection] gameOdds snapshot dual-write failed:', e.message);
    }
  }

  // 2) Authoritative Sheet write — may throw (alerts; avoids silently emptying
  //    the sheet). Snapshot above is already saved regardless.
  await clearSheet(spreadsheetId, gameOddsSheet);
  await setValues(spreadsheetId, gameOddsSheet, 'A1', rows);

  // 3) Archive to historical (append only), same as before.
  if (rows.length > 1) {
    await appendRows(spreadsheetId, historicalSheet, rows.slice(1));
  }

  return { snapshotOk };
}

module.exports = { persistGameOdds };
