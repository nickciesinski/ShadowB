'use strict';
/**
 * src/zero-data-guard.js — zero-graded-data tripwire (pure logic)
 *
 * The weekly threshold tuner silently processed 0 graded picks for THREE
 * consecutive weeks (6/21, 6/28, 7/5) despite ~289 real graded picks/week,
 * and nothing alerted. This module makes that class of failure structurally
 * loud: any tuning/optimization pass that sees zero graded picks for a
 * league that is IN SEASON must alert (via src/alerts.js at the call site).
 *
 * Pure and I/O-free so the decision itself is offline-testable — same
 * philosophy as src/staleness.js.
 */

const { isInSeason, daysSinceSeasonStart } = require('./season-windows');

/**
 * Evaluate graded-pick coverage for one league.
 *
 * @param {Object} opts
 * @param {string} opts.league
 * @param {number} opts.gradedCount  Graded picks seen in the lookback window
 * @param {Date}   [opts.now]
 * @param {number} [opts.windowDays=7]     Lookback window being evaluated
 * @param {number} [opts.minSeasonDays=3]  Grace period after season start —
 *        grading lags picks by a day, so day-1 of a season legitimately has
 *        zero graded picks. Don't cry wolf during the ramp.
 * @returns {{ok:boolean, alert:boolean, reason:string}}
 */
function evaluateGradedCoverage({ league, gradedCount, now = new Date(), windowDays = 7, minSeasonDays = 3 } = {}) {
  if (!isInSeason(league, now)) {
    return { ok: true, alert: false, reason: 'offseason' };
  }
  const sinceStart = daysSinceSeasonStart(league, now);
  if (sinceStart !== null && sinceStart < minSeasonDays) {
    return { ok: true, alert: false, reason: `season_started_${sinceStart}d_ago` };
  }
  if (!gradedCount || gradedCount <= 0) {
    return {
      ok: false,
      alert: true,
      reason: `${league} is in season but 0 graded picks were found in the last ${windowDays} days — ` +
        `grading, the Performance Log read, or the picks pipeline is broken. ` +
        `(This exact failure mode went unnoticed for 3 weeks in June 2026.)`,
    };
  }
  return { ok: true, alert: false, reason: `${gradedCount} graded picks` };
}

/**
 * Convenience: evaluate a {league: gradedCount} map and return only the
 * alerts. Callers email these via src/alerts.js.
 */
function collectZeroDataAlerts(counts, { now = new Date(), windowDays = 7 } = {}) {
  const alerts = [];
  for (const [league, gradedCount] of Object.entries(counts || {})) {
    const res = evaluateGradedCoverage({ league, gradedCount, now, windowDays });
    if (res.alert) alerts.push({ league, reason: res.reason });
  }
  return alerts;
}

/**
 * Count graded (W/L/P) Supabase performance_log rows per league.
 * Pure — takes the array already fetched by db.getRecentPerformanceLog(),
 * shaped as {league, result, ...}. Rows are assumed already date-filtered
 * by the caller's `sinceDateISO` query bound.
 *
 * @param {Array<Object>} supaRows
 * @returns {Object} {league: count}
 */
function countGradedByLeague(supaRows) {
  const counts = {};
  for (const r of (supaRows || [])) {
    const result = String((r && r.result) || '').trim().toUpperCase();
    if (result !== 'W' && result !== 'L' && result !== 'P') continue;
    const league = String((r && r.league) || '').trim().toUpperCase();
    if (!league) continue;
    counts[league] = (counts[league] || 0) + 1;
  }
  return counts;
}

/**
 * Reconcile a Sheet-sourced graded count against an independent Supabase
 * count before a zero-data tripwire fires.
 *
 * Why: the Sheet's Performance Log is subject to a read-modify-write race
 * (logPicksToPerformanceLog's full clear+rewrite vs. gradePerformanceLog's
 * in-place grade write — see src/db.js getRecentPerformanceLog comment).
 * That race is EXACTLY the failure mode that let 0-graded-picks go
 * unnoticed for 3 weeks in June 2026, so any check reading the Sheet is
 * vulnerable to reporting a false zero. Supabase writes are row-level and
 * not exposed to that race, so when it disagrees with a Sheet-reported
 * zero, Supabase wins.
 *
 * Deliberately asymmetric: this can only RAISE a zero to a real count
 * (veto a false-positive alert), never LOWER a nonzero Sheet count. If
 * Supabase is unavailable (supabaseCount not a finite number — query
 * failed or wasn't run), falls back to the Sheet count unchanged so the
 * guard stays conservative (still alerts) rather than silently trusting
 * an unverified source.
 *
 * @param {number} sheetCount
 * @param {number} [supabaseCount]
 * @returns {number} the count to feed into evaluateGradedCoverage/collectZeroDataAlerts
 */
function reconcileGradedCount(sheetCount, supabaseCount) {
  const sc = Number.isFinite(sheetCount) ? sheetCount : 0;
  if (!Number.isFinite(supabaseCount)) return sc;
  return Math.max(sc, supabaseCount);
}

module.exports = { evaluateGradedCoverage, collectZeroDataAlerts, countGradedByLeague, reconcileGradedCount };
