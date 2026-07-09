'use strict';
/**
 * src/season-verification.js — opening-week signal verification
 *
 * Two fixes in this codebase shipped with UNVERIFIABLE assumptions because
 * the relevant league was offseason at build time:
 *   1. 2026-07-07 NBA pace/defensive-rating data-collection fix — ESPN
 *      field names were widened defensively but never confirmed live.
 *   2. 2026-07-09 NHL starting-goalie signal — ESPN probables shape and
 *      real-world coverage unverifiable until October.
 *
 * Both left one-time diagnostics in the logs that a human was supposed to
 * remember to check when the season resumed. This module automates that:
 * for the first N days after a league's season starts (config/
 * season-windows.json), the daily health check (trigger16) runs hard
 * assertions and emails failures. No calendar reminders needed.
 *
 * Checks run ONLY inside the opening window — the rest of the year this
 * module contributes nothing to the health email.
 */

const { getValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');
const { seasonStartWithin } = require('./season-windows');
const { readLatestSignalHealth } = require('./signal-health');

const OPENING_WINDOW_DAYS = 7;
const SIGNAL_FRESHNESS_HOURS = 48; // coverage stat must be from a recent run

/**
 * Fill rate of specific columns in a team-stats sheet.
 * Column indices per the teamsMap builders in predictions.js:
 *   7 = offRating, 8 = defRating, 9 = pace
 */
async function teamStatsFillRate(sheetName, colIndices) {
  const rows = await getValues(SPREADSHEET_ID, sheetName);
  if (!rows || rows.length < 2) return { rate: 0, teams: 0 };
  let filled = 0, teams = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !(row[2] || '').toString().trim()) continue; // no team name
    teams++;
    const allPresent = colIndices.every(ci => {
      const v = row[ci];
      return v !== undefined && v !== null && String(v).trim() !== '' && !isNaN(parseFloat(v));
    });
    if (allPresent) filled++;
  }
  return { rate: teams > 0 ? filled / teams : 0, teams };
}

function checkSignalFreshCoverage(healthMap, league, signal, minCoverage, now) {
  const entry = healthMap.get(`${league}|${signal}`);
  if (!entry) {
    return { ok: false, detail: `no ${signal} record found — the emitter in predictions.js never ran or Signal_Health writes are failing` };
  }
  const ageHours = (now - entry.ts) / 3600000;
  if (ageHours > SIGNAL_FRESHNESS_HOURS) {
    return { ok: false, detail: `latest ${signal} is ${ageHours.toFixed(0)}h old (>${SIGNAL_FRESHNESS_HOURS}h) — predictions may not be running` };
  }
  if (entry.coverage === null || entry.coverage < minCoverage) {
    return { ok: false, detail: `${signal} = ${entry.coverage === null ? 'n/a' : (entry.coverage * 100).toFixed(0) + '%'} (< ${minCoverage * 100}% required) — ${entry.detail}` };
  }
  return { ok: true, detail: `${signal} = ${(entry.coverage * 100).toFixed(0)}% (${entry.detail}, ${ageHours.toFixed(0)}h old)` };
}

/**
 * Run all applicable season-start checks.
 * @returns {Array<{league, check, ok, detail}>} empty when no league is in
 *          its opening window (the common case).
 */
async function runSeasonStartChecks(now = new Date()) {
  const results = [];

  const nbaOpening = seasonStartWithin('NBA', now, OPENING_WINDOW_DAYS);
  const nhlOpening = seasonStartWithin('NHL', now, OPENING_WINDOW_DAYS);
  const mlbOpening = seasonStartWithin('MLB', now, OPENING_WINDOW_DAYS);
  if (!nbaOpening && !nhlOpening && !mlbOpening) return results;

  let healthMap = null;
  if (nhlOpening || mlbOpening) {
    healthMap = await readLatestSignalHealth();
  }

  if (nbaOpening) {
    // Validates the 2026-07-07 defensive guess at ESPN's NBA field names:
    // if pace/defRating are still null for most teams, the fallbacks failed
    // and the largest NBA total weight is running on zeros again.
    try {
      const { rate, teams } = await teamStatsFillRate(SHEETS.NBA_TEAM_STATS, [8, 9]);
      results.push({
        league: 'NBA', check: 'pace/defRating fill (7/7 fix verification)',
        ok: rate >= 0.5,
        detail: `${(rate * 100).toFixed(0)}% of ${teams} teams have defRating+pace populated${rate < 0.5 ? ' — check trigger2 one-time diagnostic log for real ESPN stat keys' : ''}`,
      });
    } catch (err) {
      results.push({ league: 'NBA', check: 'pace/defRating fill', ok: false, detail: `check errored: ${err.message}` });
    }
  }

  if (nhlOpening) {
    // Validates the 2026-07-09 goalie signal: coverage should be near-total
    // via the rankings-sheet fallback even if ESPN probables never appear.
    results.push({
      league: 'NHL', check: 'goalie signal coverage (new-signal verification)',
      ...checkSignalFreshCoverage(healthMap, 'NHL', 'goalie_coverage', 0.5, now),
    });
  }

  if (mlbOpening) {
    results.push({
      league: 'MLB', check: 'pitcher lookup coverage',
      ...checkSignalFreshCoverage(healthMap, 'MLB', 'pitcher_coverage', 0.8, now),
    });
  }

  return results;
}

module.exports = { runSeasonStartChecks, teamStatsFillRate, OPENING_WINDOW_DAYS };
