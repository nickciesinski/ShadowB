'use strict';
// 2026-10-02 — one team's missing stat read as 0 and was differenced against
// the other team's real stat: Montréal (name miss), NYR (one game), BUF (0 GP)
// each produced defense/goal diffs of ±1.6-1.8, half the score. Unknown on
// either side must mean "no evidence of a gap", i.e. 0.
const test = require('node:test');
const assert = require('node:assert');
const { extractFeatures } = require('../src/game-features');
const { nhlPerGame } = require('../src/data-collection');

const full = { goalsFor: 3.1, goalsAgainst: 3.2, wins: 0, losses: 0, pct: '0.5' };

test('NHL: a team with no stats produces no gap', () => {
  const f = extractFeatures({}, full, null, 'NHL');
  assert.strictEqual(f.defense_ga_diff, 0);
  assert.strictEqual(f.goal_differential_diff, 0);
  assert.strictEqual(f.offense_gf_diff, 0);
});

test('NHL: both known still produces the real gap', () => {
  const f = extractFeatures({ ...full, goalsAgainst: 2.8 }, full, null, 'NHL');
  assert.ok(Math.abs(f.defense_ga_diff - (3.2 - 2.8) / 2) < 1e-9);
});

test('NHL: a team flipped to the new season with 0 games reads as league average', () => {
  assert.strictEqual(nhlPerGame({ games: 0, goals: 0, goalsAgainst: 0 }, ['avgGoalsAgainst'], ['goalsAgainst']), 3.0);
});

test('NFL: points margin needs all four rates', () => {
  const f = extractFeatures({ pointsFor: 24 }, { pointsFor: 20, pointsAgainst: 22 }, null, 'NFL');
  assert.strictEqual(f.nfl_points_margin, 0);
});
