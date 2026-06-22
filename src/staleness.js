'use strict';
/**
 * src/staleness.js
 *
 * Pure staleness decision for the Supabase `performance_log` dual-write health
 * check. Extracted verbatim (behavior-preserving) from the inline logic in
 * scripts/admin-reset.js `verifySupabaseRecency()` so the alert decision is
 * offline-unit-testable. This closes Autopilot blocker #4: "verify the
 * staleness alert actually fires on a simulated stale-data condition."
 *
 * Context: the 41-day Supabase outage went unnoticed because a silent failure
 * printed success. The recency gate (latest row older than 2 days => STALE) is
 * the tripwire that should have fired. Making it a pure function lets a test
 * prove it fires — without needing a live Supabase connection.
 *
 * This module performs NO I/O and has NO side effects.
 *
 * @param {Object} opts
 * @param {Array<{date:string}>|null|undefined} opts.rows
 *        Rows from the recency query, newest first (the query is
 *        `.order('date', {ascending:false}).limit(1)`).
 * @param {number} [opts.nowMs=Date.now()]  Current time in ms (injectable for tests).
 * @param {number} [opts.maxAgeDays=STALE_MAX_AGE_DAYS]  Stale threshold in days.
 * @returns {{ok:boolean, reason?:string, latest?:string, ageDays?:number}}
 *          Same shape the caller already returns:
 *          - no rows            -> { ok:false, reason:'empty_table' }
 *          - age > maxAgeDays   -> { ok:false, reason:'stale', latest, ageDays }
 *          - otherwise          -> { ok:true, latest, ageDays }
 */
const STALE_MAX_AGE_DAYS = 2;
const MS_PER_DAY = 86400000;

function evaluateRecency({ rows, nowMs = Date.now(), maxAgeDays = STALE_MAX_AGE_DAYS } = {}) {
  if (!rows || rows.length === 0) {
    return { ok: false, reason: 'empty_table' };
  }
  const latest = rows[0].date;
  const ageDays = (nowMs - new Date(latest).getTime()) / MS_PER_DAY;
  if (ageDays > maxAgeDays) {
    return { ok: false, reason: 'stale', latest, ageDays };
  }
  return { ok: true, latest, ageDays };
}

module.exports = { evaluateRecency, STALE_MAX_AGE_DAYS };
