'use strict';
// 2026-10-31 — injury rows are keyed by ESPN abbreviation; the model has full names.
const test = require('node:test');
const assert = require('node:assert');
const { teamAbbr, ABBR } = require('../src/team-abbr');

test('maps the odds-feed spellings to ESPN abbreviations', () => {
  assert.strictEqual(teamAbbr('NHL', 'Montréal Canadiens'), 'MTL');
  assert.strictEqual(teamAbbr('NHL', 'St Louis Blues'), 'STL');
  assert.strictEqual(teamAbbr('NHL', 'Utah Mammoth'), 'UTA');
  assert.strictEqual(teamAbbr('NBA', 'Golden State Warriors'), 'GS');
  assert.strictEqual(teamAbbr('NBA', 'Utah Jazz'), 'UTAH');
  assert.strictEqual(teamAbbr('NFL', 'Washington Commanders'), 'WSH');
  assert.strictEqual(teamAbbr('MLB', 'St. Louis Cardinals'), 'STL');
});

test('unknown team or league returns empty, never throws', () => {
  assert.strictEqual(teamAbbr('NBA', 'Seattle SuperSonics'), '');
  assert.strictEqual(teamAbbr('EPL', 'Arsenal'), '');
  assert.strictEqual(teamAbbr(undefined, undefined), '');
});

test('every league has a full roster', () => {
  const counts = Object.fromEntries(Object.entries(ABBR).map(([l, t]) => [l, new Set(Object.values(t)).size]));
  assert.deepStrictEqual(counts, { NBA: 30, NHL: 32, NFL: 32, MLB: 30 });
});
