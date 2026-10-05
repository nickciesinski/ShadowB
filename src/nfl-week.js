'use strict';
// =============================================================
// src/nfl-week.js — how far ahead NFL picks may lock.
//
// 2026-10-05 (Nick): lock the WHOLE next NFL week in one go on Sunday evening,
// so the picks are in before his ~9 PM PT betting window and he can take the
// early lines (most books move by Monday morning).
//
// NFL weeks run Tuesday → Monday (Thursday, Sunday and Monday-night games).
//   - Sunday from 3 PM PT, and Monday: everything through the END of NEXT week.
//     The Sunday-evening run locks the slate; Monday runs only top up games
//     whose odds weren't posted yet.
//   - Any other time: only the CURRENT week. This is what stops a Thursday
//     game locking a week early on the previous Thursday (a flat "7 days out"
//     rule did that, and also missed next Monday night from the Sunday run).
//
// Picks never flip once locked (insertPerformanceRows ignores duplicates), so
// this only decides WHEN a game first gets its pick.
// =============================================================

const SUNDAY_EVENING_FROM_HOUR = 15; // excludes the ~5:30 AM run; DST-proof for the ~7-8 PM run

/** Pacific wall-clock view of an instant (fields read with getDay/getHours). */
function pacific(now) {
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

/**
 * The latest kickoff time (ms) that may get a pick on a run at `now`.
 * Returned as a real instant: Tuesday 00:00 Pacific at the end of the
 * current week, or of next week from Sunday afternoon on.
 */
function nflLockHorizon(now = new Date()) {
  const pt = pacific(now);
  const dow = pt.getDay(); // 0 = Sunday, 1 = Monday, 2 = Tuesday
  let days = ((2 - dow + 7) % 7) || 7; // to the coming Tuesday 00:00 PT
  const nextWeek = (dow === 0 && pt.getHours() >= SUNDAY_EVENING_FROM_HOUR) || dow === 1;
  if (nextWeek) days += 7;
  const endPt = new Date(pt);
  endPt.setHours(0, 0, 0, 0);
  endPt.setDate(endPt.getDate() + days);
  // pt and endPt are both Pacific wall-clock; their gap is real elapsed time
  // (an hour off across a DST switch, which a midnight cutoff can absorb).
  return now.getTime() + (endPt.getTime() - pt.getTime());
}

module.exports = { nflLockHorizon, SUNDAY_EVENING_FROM_HOUR };
