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
