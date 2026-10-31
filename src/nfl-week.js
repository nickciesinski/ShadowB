'use strict';
// =============================================================
// src/nfl-week.js — how far ahead NFL picks may lock.
//
// 2026-10-31 (Nick): lock each NFL game the NIGHT BEFORE, not a week ahead.
// Picks locked ~6.5 days early were made before the week's injury report
// existed; on the clean-era ledger the picks that went on to beat the close
// returned +21% and the rest -24%, i.e. late information decided the result.
//
// Rule: a game may lock once kickoff is within LOCK_HOURS. With the slate build
// at ~7 PM PT (02:00 UTC) that means:
//   - Saturday-evening run  -> every Sunday game (early, late, SNF)
//   - Sunday-evening run    -> Monday night
//   - Wednesday-evening run -> Thursday night
//   - the ~5 AM PT top-up only reaches games that same day/evening, so a
//     Sunday 10 AM PT kickoff is never locked on Saturday morning.
// If the evening build is missed, the next morning's top-up still covers that
// day's games, so a dropped run costs early lines, never a pick.
//
// This also bounds the NFL odds fetch (data-collection.js). Closing-line
// capture only needs games near kickoff, so CLV is unaffected.
//
// Picks never flip once locked (insertPerformanceRows ignores duplicates), so
// this only decides WHEN a game first gets its pick.
// =============================================================

const LOCK_HOURS = 26;

/** The latest kickoff time (ms) that may get a pick on a run at `now`. */
function nflLockHorizon(now = new Date()) {
  return now.getTime() + LOCK_HOURS * 3600e3;
}

module.exports = { nflLockHorizon, LOCK_HOURS };
