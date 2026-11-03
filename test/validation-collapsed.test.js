'use strict';
// 2026-11-03 — validation flagged league constants (home advantage) as
// "collapsed" every day; feature-health already knew they are constant.
const test = require('node:test');
const assert = require('node:assert');
const { checkDeadWeights } = require('../src/feature-health');

test('NFL rest/bye features are not reported as dead weights', () => {
  const r = checkDeadWeights('NFL');
  const unexpected = (r.markets || []).flatMap((m) => m.unexpected || []);
  assert.ok(!unexpected.some((u) => u.startsWith('nfl_rest_days_diff') || u.startsWith('nfl_off_bye_diff')),
    unexpected.join(','));
});

test('home-advantage constants are not "collapsed"; a real stuck feature still is', async () => {
  const { checkFeatures } = require('../src/daily-validation');
  const rows = Array.from({ length: 8 }, (_, i) => ({ league: 'NBA', features: {
    home_court_advantage: 0.15, home_away_split_diff: 0.02, severe_injury_factor: 1,
    home_injury_weight: 1, pace_diff: i / 10,
  } }));
  const sb = { from: () => ({ select: () => ({ gte: () => ({ limit: async () => ({ data: rows }) }) }) }) };
  const out = await checkFeatures(sb, '2026-11-03');
  assert.deepStrictEqual(out.collapsed, { NBA: ['home_injury_weight'] });
});
