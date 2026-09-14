'use strict';
// 2026-09-13 — the plumbing between a game and its candidate features.
//
// Two bugs lived here, both silent, both found only by querying what had
// actually been logged rather than trusting the unit tests of each module:
//
//   1. commenceTime was read from game.commenceTime / start_time / startTime.
//      buildGameObjects produces `commence`, so all three were undefined and
//      every feature that needs a start time was absent in production — MLB
//      rest_hours_diff logged 0 times, NFL rest/short-week/off-bye never
//      appeared, and NBA/NHL back-to-back and density would have been dead on
//      opening day. Every module's own tests passed throughout.
//
//   2. The slate date was read from games[0].gameDate || games[0].date.
//      Neither exists, so it fell back to UTC "today" and gave every game the
//      same anchor, including lookahead games days out. The game-date anchoring
//      that keeps Nick's 9 PM and 5:30 AM builds consistent never engaged.
//
// Nick is leaving this to collect unattended for weeks. Both bugs are the kind
// that cost exactly that: data that looks present and is not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const modelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'game-model.js'), 'utf8');
const predSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'predictions.js'), 'utf8');

test('buildGameObjects still names the start time `commence`', () => {
  // If this changes, the wiring below must change with it.
  assert.match(predSrc, /games\[gk\]\s*=\s*\{\s*home,\s*away,\s*commence,/,
    'buildGameObjects no longer produces { home, away, commence } — update game-model');
});

test('candidate features read the start time from game.commence', () => {
  assert.match(modelSrc, /commenceTime:\s*game\.commence\s*,/);
  assert.doesNotMatch(modelSrc, /game\.commenceTime|game\.start_time|game\.startTime/,
    'those fields do not exist on a game object — reading them yields undefined');
});

test('no candidate code reads a date field games do not have', () => {
  // Code lines only: the explanatory comment describing this very bug quotes
  // the old expression and must not trip the check.
  const code = modelSrc.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /games\[0\][^\n]*\.(gameDate|date)\b/,
    'games carry no gameDate/date; a single slate-wide date collapses every game to one anchor');
});

test('candidate context is resolved per game from its own commence time', () => {
  assert.match(modelSrc, /contextFor\(ptDateOf\(game\.commence\)\)/);
});

test('a late West-Coast game resolves to its PACIFIC date, not its UTC date', () => {
  // 7:10 PM PT on the 13th is 02:10 UTC on the 14th. Anchoring to UTC would
  // hand this game the next day's probables and a window one day too late.
  const ptDateOf = (c) => new Date(c).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  assert.strictEqual(ptDateOf('2026-09-14T02:10:00Z'), '2026-09-13');
  assert.strictEqual(ptDateOf('2026-09-14T17:10:00Z'), '2026-09-14');
  // Across the November DST change the conversion must still land right.
  assert.strictEqual(ptDateOf('2026-11-02T07:30:00Z'), '2026-11-01');
});

test('rest features reach extractFeatures when a start time is supplied', () => {
  // Functional check of the path the bug broke: with commenceTime present, the
  // start-time-dependent features appear; without it they are omitted.
  const { extractFeatures } = require('../src/game-features');
  const nflCtx = { gameDate: '2026-09-13', previous: new Map([
    ['cincinnatibengals', { when: '2026-09-07T17:00:00Z', venueTeam: 'Cincinnati Bengals' }],
    ['tampabaybuccaneers', { when: '2026-09-07T17:00:00Z', venueTeam: 'Tampa Bay Buccaneers' }],
  ]) };
  const base = { nflCtx, homeTeam: 'Cincinnati Bengals', awayTeam: 'Tampa Bay Buccaneers' };
  const withTime = extractFeatures({}, {}, null, 'NFL', { ...base, commenceTime: '2026-09-13T17:00:00Z' });
  const without = extractFeatures({}, {}, null, 'NFL', base);
  assert.ok('nfl_rest_days_diff' in withTime, 'present when the start time arrives');
  assert.ok(!('nfl_rest_days_diff' in without), 'and honestly absent when it does not');
});
