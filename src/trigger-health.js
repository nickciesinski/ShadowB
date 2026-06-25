'use strict';
// =============================================================
// src/trigger-health.js
//
// Pure, dependency-free helpers for the daily trigger health check
// (sendTriggerHealthCheck in emails.js). Kept separate so the
// "expected vs ran vs missing" logic is offline-unit-testable and so the
// Sheets/Supabase merge can't silently develop a blind spot again.
// =============================================================

// Triggers expected to run on a given ET day-of-week (0=Sun … 6=Sat).
// trigger13 only runs Monday (01:00 UTC = Sun 8PM ET).
function expectedTriggersFor(dayOfWeek) {
  const daily = [
    'trigger1', 'trigger2', 'trigger3', 'trigger4',
    'trigger6', 'trigger7', 'trigger8', 'trigger9',
    'trigger10', 'trigger11', 'trigger12', 'trigger14',
  ];
  if (dayOfWeek === 1) daily.push('trigger13');
  return daily;
}

// Backfill a Sheets-derived runMap with Supabase trigger_log rows. Sheets data
// wins per-trigger; Supabase fills anything the sheet didn't capture. Returns a
// NEW map (does not mutate the input). This must run UNCONDITIONALLY — the
// Trigger_Monitor sheet drops writes as it nears the 10M-cell cap, so gating the
// backup on a sheet-row count is exactly how real runs get mis-reported missing.
function mergeTriggerRuns(runMap, dbRuns) {
  const merged = Object.assign({}, runMap);
  for (const row of dbRuns || []) {
    const name = row && row.trigger_name ? row.trigger_name : '';
    if (!name || merged[name]) continue; // Sheets precedence
    merged[name] = {
      status: row.status || '',
      duration: row.duration_sec != null ? String(row.duration_sec) : '',
      error: row.error_message || '',
    };
  }
  return merged;
}

// Split expected triggers into passed / failed / missing given the merged runMap.
function categorize(expected, runMap) {
  const passed = [], failed = [], missing = [];
  for (const name of expected) {
    const run = runMap[name];
    if (!run) missing.push(name);
    else if (run.status === 'FAILED') failed.push({ name, error: run.error, duration: run.duration });
    else passed.push({ name, duration: run.duration });
  }
  return { passed, failed, missing };
}

module.exports = { expectedTriggersFor, mergeTriggerRuns, categorize };
