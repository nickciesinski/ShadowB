'use strict';
/**
 * src/season-windows.js — league season calendar (pure logic)
 *
 * Reads config/season-windows.json and answers "is this league in season
 * right now?" so watchdogs can tell offseason silence (fine) apart from
 * in-season silence (broken). Before this existed, a dead NHL pipeline in
 * November looked identical to the normal NHL offseason in July.
 *
 * All functions take an injectable `date` for offline testing.
 * Windows are month-day pairs and may wrap the year boundary (NFL, NBA, NHL).
 */

const fs = require('fs');
const path = require('path');

let _windows = null;

function loadWindows() {
  if (_windows) return _windows;
  const fp = path.join(__dirname, '..', 'config', 'season-windows.json');
  _windows = JSON.parse(fs.readFileSync(fp, 'utf8')).leagues || {};
  return _windows;
}

/** Parse "MM-DD" → { month (1-12), day }. */
function parseMonthDay(md) {
  const m = String(md || '').match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return { month: parseInt(m[1]), day: parseInt(m[2]) };
}

/** Numeric key for comparing month-days: 315 = Mar 15. */
function mdKey(month, day) { return month * 100 + day; }

/**
 * Is `league` in season on `date`?
 * Handles wrap-around windows (e.g. NHL Oct 1 → Jun 30).
 * Unknown league → true (fail open: better a spurious alert than a
 * silenced one for a league we forgot to configure).
 */
function isInSeason(league, date = new Date()) {
  const win = loadWindows()[String(league || '').toUpperCase()];
  if (!win) return true;
  const start = parseMonthDay(win.start);
  const end = parseMonthDay(win.end);
  if (!start || !end) return true;

  const now = mdKey(date.getMonth() + 1, date.getDate());
  const s = mdKey(start.month, start.day);
  const e = mdKey(end.month, end.day);

  if (s <= e) return now >= s && now <= e;   // same-year window (MLB)
  return now >= s || now <= e;               // wraps year boundary (NHL/NBA/NFL)
}

/** All configured leagues in season on `date`. */
function leaguesInSeason(date = new Date()) {
  return Object.keys(loadWindows()).filter(lg => isInSeason(lg, date));
}

/**
 * Days since the current season started, or null if offseason.
 * For wrap windows, the start is the most recent occurrence of the
 * start month-day on or before `date`.
 */
function daysSinceSeasonStart(league, date = new Date()) {
  if (!isInSeason(league, date)) return null;
  const win = loadWindows()[String(league || '').toUpperCase()];
  if (!win) return null;
  const start = parseMonthDay(win.start);
  if (!start) return null;

  let startDate = new Date(date.getFullYear(), start.month - 1, start.day);
  if (startDate > date) startDate = new Date(date.getFullYear() - 1, start.month - 1, start.day);
  return Math.floor((date - startDate) / 86400000);
}

/**
 * True if `league` is in season AND the season started within the last
 * `days` days — the trigger condition for opening-week verification.
 */
function seasonStartWithin(league, date = new Date(), days = 7) {
  const since = daysSinceSeasonStart(league, date);
  return since !== null && since <= days;
}

/** Test hook: inject a windows object instead of reading the config file. */
function _setWindowsForTest(w) { _windows = w; }

module.exports = {
  isInSeason,
  leaguesInSeason,
  daysSinceSeasonStart,
  seasonStartWithin,
  _setWindowsForTest,
};
