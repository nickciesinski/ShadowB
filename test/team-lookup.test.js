'use strict';
// 2026-09-29 — "Montréal Canadiens" (odds feed) vs "Montreal Canadiens" (ESPN)
// missed, and a miss became all-zero stats (defense_ga_diff -1.8 on opening night).
const test = require('node:test');
const assert = require('node:assert');
const { lookupTeam } = require('../src/game-model');

const teams = { 'Montreal Canadiens': { goalsAgainst: 3.06 }, 'Toronto Maple Leafs': { goalsAgainst: 3.6 } };

test('accented name finds the unaccented stats row', () => {
  assert.strictEqual(lookupTeam(teams, 'Montréal Canadiens').goalsAgainst, 3.06);
});
test('exact match still wins; true miss is still empty', () => {
  assert.strictEqual(lookupTeam(teams, 'Toronto Maple Leafs').goalsAgainst, 3.6);
  assert.deepStrictEqual(lookupTeam(teams, 'Seattle Kraken'), {});
});

test('Odds API "Los Angeles Clippers" finds ESPN "LA Clippers"', () => {
  const nba = { 'LA Clippers': { pointsFor: 113.8 } };
  assert.strictEqual(lookupTeam(nba, 'Los Angeles Clippers').pointsFor, 113.8);
});

test('schedule-style lookup returns the caller fallback on a miss', () => {
  assert.strictEqual(lookupTeam({ 'LA Clippers': { b2b: true } }, 'Seattle Kraken', null), null);
});
