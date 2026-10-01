'use strict';
// 2026-10-01 — one-game NHL rates (NYR 0 GF / 3 GA) were compared against a
// full prior season; values outside 1.5-5.5 were also dropped to 0.
const test = require('node:test');
const assert = require('node:assert');
const { nhlPerGame } = require('../src/data-collection');
const GF = [['avgGoals'], ['goalsFor', 'goals']];
const GA = [['avgGoalsAgainst'], ['goalsAgainst', 'opponentGoals']];

test('one game is blended toward league average, never dropped to 0', () => {
  const nyr = { games: 1, goals: 0, goalsAgainst: 3 };
  const gf = nhlPerGame(nyr, ...GF), ga = nhlPerGame(nyr, ...GA);
  assert.ok(gf > 2.6 && gf < 3.0, `0 goals in 1 game → ~2.73, got ${gf}`);
  assert.ok(Math.abs(ga - 3.0) < 1e-9, `3 allowed in 1 game → 3.0, got ${ga}`);
  const la = { games: 1, goals: 4, goalsAgainst: 8 };
  assert.ok(nhlPerGame(la, ...GA) > 3.0 && nhlPerGame(la, ...GA) < 3.6, '8 allowed is pulled in, not rejected');
});

test('a full season is used as-is', () => {
  const v = nhlPerGame({ games: 82, goals: 298, goalsAgainst: 197 }, ...GF);
  assert.ok(Math.abs(v - 298 / 82) < 1e-9);
});
