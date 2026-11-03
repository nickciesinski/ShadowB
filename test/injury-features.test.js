'use strict';
// 2026-10-31 — injury features read 0 for every game because the lookup used a
// team abbreviation the stats rows never had. They must now reach the model.
const test = require('node:test');
const assert = require('node:assert');
const { setInjuryScores, resetInjuryCache, tierFromRating } = require('../src/injury-impact');
const { extractFeatures } = require('../src/game-features');

test('injury scores reach the feature vector via the game team names', () => {
  setInjuryScores({ 'NBA|GS': 0.6, 'NBA|BOS': 0.1 });
  const f = extractFeatures({ pct: '0.5' }, { pct: '0.5' }, null, 'NBA',
    { homeTeam: 'Boston Celtics', awayTeam: 'Golden State Warriors' });
  assert.strictEqual(f.home_injury_weight, 0.1);
  assert.strictEqual(f.away_injury_weight, 0.6);
  assert.ok(Math.abs(f.injury_weight_diff - 0.5) < 1e-9, 'away more hurt = positive for home');
  assert.strictEqual(f.severe_injury_factor, 1);
  resetInjuryCache();
});

test('player rating sets the tier: a rated star outranks a rated backup', () => {
  assert.strictEqual(tierFromRating(91), 'S');
  assert.strictEqual(tierFromRating(55), 'B');
  assert.strictEqual(tierFromRating(12), 'D');
});

// 2026-11-03 — NBA injury scores pinned at 1.0 for nearly every team.
test('NBA guards are not rated like NHL goalies', () => {
  const { positionScore } = require('../src/injury-impact');
  assert.strictEqual(positionScore('NHL', 'G'), 85);
  assert.strictEqual(positionScore('NBA', 'G'), 50);
  assert.strictEqual(positionScore('NFL', 'QB'), 90);
});

test('an unknown OUT player does not max out a team on his own', () => {
  const { getImpactFallback } = require('../src/injury-impact');
  // data-collection writes impact 1.0 for every OUT player
  const sev = getImpactFallback(['', '', '', '', 'out', '', '1'], 6, 1.0);
  assert.ok(sev <= 0.2, `got ${sev}`);
});
