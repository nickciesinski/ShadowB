'use strict';
// Offline tests for the drift guard's one-sided totals detector.
// 2026-10-26: NBA totals went 43/43 Over while total_market_anchor was already
// at its safe value, so the anchor reset could not fix it. These pin the
// detector that finds the feature actually pushing every game one way.
const test = require('node:test');
const assert = require('node:assert');
const { findOneSidedTotalFeatures } = require('../src/drift-guard');

// 30 games shaped like the 10/19-10/26 NBA slate.
function slate() {
  const rows = [];
  for (let g = 0; g < 30; g++) {
    rows.push({ features: {
      sp_pred_total: 4 + (g % 5),          // always positive: stale baseline
      pace_combined: 0.5,                   // stuck placeholder
      offense_ppg_diff: g % 2 ? 0.4 : -0.4, // real signal: moves both ways
    } });
  }
  return rows;
}
const WEIGHTS = { sp_pred_total: 0.55, pace_combined: 1, offense_ppg_diff: 1, nba_pace_est: 0 };

test('flags the features that push every game Over, biggest first', () => {
  const out = findOneSidedTotalFeatures(slate(), WEIGHTS, 1);
  assert.deepStrictEqual(out.map(c => c.feature), ['sp_pred_total', 'pace_combined']);
  assert.strictEqual(out[0].share, 1);
});

test('a big lean is flagged even when a few games go the other way', () => {
  // The real 10/19-10/26 sp_pred_total: Over on 85% of games, mean ~1.2x its sd.
  const rows = slate().map((r, g) => ({ features: { sp_pred_total: g % 7 === 0 ? -1 : 5 + (g % 4) } }));
  const out = findOneSidedTotalFeatures(rows, { sp_pred_total: 0.55 }, 1);
  assert.deepStrictEqual(out.map(c => c.feature), ['sp_pred_total']);
  assert.ok(out[0].share < 0.9);
});

test('a two-way signal is never flagged', () => {
  const out = findOneSidedTotalFeatures(slate(), WEIGHTS, 1);
  assert.ok(!out.some(c => c.feature === 'offense_ppg_diff'));
});

test('an Over-pushing feature is not blamed for an Under drift', () => {
  assert.deepStrictEqual(findOneSidedTotalFeatures(slate(), WEIGHTS, -1), []);
});

test('zero-weight features and thin samples are ignored', () => {
  assert.deepStrictEqual(findOneSidedTotalFeatures(slate().slice(0, 5), WEIGHTS, 1), []);
  const out = findOneSidedTotalFeatures(slate(), { nba_pace_est: 0 }, 1);
  assert.deepStrictEqual(out, []);
});

test('a small constant nudge below the floor is left alone', () => {
  const rows = slate().map(r => ({ features: { ...r.features, tiny: 0.05 } }));
  const out = findOneSidedTotalFeatures(rows, { tiny: 1 }, 1);
  assert.deepStrictEqual(out, []);
});
