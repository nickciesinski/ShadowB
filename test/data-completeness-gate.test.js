'use strict';
// 2026-09-04 — exclude picks made on a fraction of the model from measurement.
//
// NFL week 1: 21 of 68 features carry values and the three heaviest weights are
// exactly zero, so turnover_impact lands at 50% of the score and the dominance
// guard fires. Measured completeness NFL 0.05-0.20 vs MLB 0.65-0.90. Those
// picks were never staked (the approval gate already refuses them) but they
// WERE entering the measurement baseline as ordinary evidence about the model.
const test = require('node:test');
const assert = require('node:assert');
const { isMeasurable, MIN_DATA_COMPLETENESS } = require('../src/daily-validation');

test('the measurement bar equals the staking bar', () => {
  const cfg = require('../config/approval-thresholds.json');
  assert.strictEqual(MIN_DATA_COMPLETENESS, cfg.default.minDataCompleteness,
    'two thresholds would drift, and the pair that drifted would measure one population and bet another');
});

test('real NFL week-1 completeness is excluded, real MLB is kept', () => {
  for (const dc of [0.05, 0.10, 0.20]) {
    assert.strictEqual(isMeasurable({ data_completeness: dc }), false, `NFL wk1 ${dc} must be excluded`);
  }
  for (const dc of [0.65, 0.80, 0.90]) {
    assert.strictEqual(isMeasurable({ data_completeness: dc }), true, `MLB ${dc} must be kept`);
  }
});

test('the boundary is inclusive', () => {
  assert.strictEqual(isMeasurable({ data_completeness: 0.3 }), true);
  assert.strictEqual(isMeasurable({ data_completeness: 0.299 }), false);
});

test('NULL completeness is KEPT — pre-column rows must not vanish', () => {
  // Every row written before 2026-09-04 has no value here. Dropping them would
  // silently rewrite the baseline the kill criterion was measured against.
  assert.strictEqual(isMeasurable({ data_completeness: null }), true);
  assert.strictEqual(isMeasurable({}), true);
  assert.strictEqual(isMeasurable({ data_completeness: '' }), true);
});

test('the unreachable-book exclusion still applies independently', () => {
  assert.strictEqual(isMeasurable({ tradeable: false, data_completeness: 0.9 }), false);
  assert.strictEqual(isMeasurable({ tradeable: true, data_completeness: 0.9 }), true);
  assert.strictEqual(isMeasurable({ tradeable: false, data_completeness: null }), false);
});

test('a junk row is not silently measurable', () => {
  assert.strictEqual(isMeasurable(null), false);
  assert.strictEqual(isMeasurable(undefined), false);
});

test('the threshold is injectable so a future change can be tested', () => {
  assert.strictEqual(isMeasurable({ data_completeness: 0.5 }, 0.6), false);
  assert.strictEqual(isMeasurable({ data_completeness: 0.5 }, 0.4), true);
});
