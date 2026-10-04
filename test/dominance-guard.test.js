'use strict';
// Dominance guard threshold (2026-10-04). Real faults sat far above 60% of the
// score; healthy close games sat at 40-56% and were firing the alert daily.
const test = require('node:test');
const assert = require('node:assert');
const { checkDominance } = require('../src/game-features');

test('close game with a normal turnover gap does not fire (Colts@Commanders 10-04)', () => {
  // turnover_impact 0.467 * 1.8 = 0.84 of a ~1.72 total => ~49%
  const r = checkDominance(
    { turnover_impact: 0.4667, nfl_points_margin: 0.3, yards_diff: 0.5, red_zone_diff: 0.66 },
    { turnover_impact: 1.8, nfl_points_margin: 1.0, yards_diff: 0.45, red_zone_diff: 0.35 });
  assert.equal(r.dominated, false);
});

test('playoff OPS corruption still fires (Yankees@Rays 10-02, 75%)', () => {
  const r = checkDominance(
    { ops_diff: -2.815, whip_diff: 0.5, run_differential_diff: 0.05 },
    { ops_diff: 0.4, whip_diff: 0.45, run_differential_diff: 1.7 });
  assert.equal(r.dominated, true);
  assert.equal(r.offenders[0].feature, 'ops_diff');
});

test('one feature carrying everything (data outage) fires', () => {
  const r = checkDominance({ offense_ppg_diff: -3.7, yards_diff: 0 },
    { offense_ppg_diff: 1.5, yards_diff: 0.45 });
  assert.equal(r.dominated, true);
});
