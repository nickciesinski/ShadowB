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
