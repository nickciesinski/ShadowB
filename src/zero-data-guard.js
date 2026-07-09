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

module.exports = { evaluateGradedCoverage, collectZeroDataAlerts };
