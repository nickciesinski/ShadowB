'use strict';
// R2.1: line-shopping price math. Pins best/median derivation offline so the
// live buildGameObjects wiring stays additive and non-breaking.
const test = require('node:test');
const assert = require('node:assert');
const { bestAmericanPrice, medianAmericanPrice, priceStats, selectGradedPrice } = require('../src/price-lib');

test('bestAmericanPrice picks the most favorable price to the bettor', () => {
  // Plus money: higher is better.
  assert.strictEqual(bestAmericanPrice([100, 120, 110]), 120);
  // Minus money: closer to zero (numerically larger) is better.
  assert.strictEqual(bestAmericanPrice([-110, -105, -120]), -105);
  // Across the sign boundary: +100 beats -105.
  assert.strictEqual(bestAmericanPrice([-105, -110, 100]), 100);
});

test('bestAmericanPrice ignores junk and empty input', () => {
  assert.strictEqual(bestAmericanPrice([-110, '', 0, 'x', NaN]), -110);
  assert.strictEqual(bestAmericanPrice([]), null);
  assert.strictEqual(bestAmericanPrice(['', 0]), null);
  assert.strictEqual(bestAmericanPrice(null), null);
});

test('medianAmericanPrice matches buildGameObjects convention (floor(n/2))', () => {
  // Sorted [-120,-110,-105] -> index 1 -> -110.
  assert.strictEqual(medianAmericanPrice([-105, -120, -110]), -110);
  // Even count [-110,-105] -> index 1 -> -105 (upper-middle, as legacy code does).
  assert.strictEqual(medianAmericanPrice([-110, -105]), -105);
  // Junk dropped before median.
  assert.strictEqual(medianAmericanPrice([-110, '', -105, 0, -120]), -110);
  assert.strictEqual(medianAmericanPrice([]), null);
});

test('best is always >= median (line-shopping never hurts the logged price)', () => {
  const samples = [
    [-110, -105, -115, 120],
    [100, 105, 110],
    [-200, -180, -210, -190],
  ];
  for (const s of samples) {
    const { median, best } = priceStats(s);
    assert.ok(best >= median, `best ${best} should be >= median ${median} for ${s}`);
  }
});

test('priceStats reports usable count and both prices', () => {
  assert.deepStrictEqual(priceStats([-110, -105, 120, '', 0]), { median: -105, best: 120, n: 3 });
  assert.deepStrictEqual(priceStats([]), { median: null, best: null, n: 0 });
});

test('selectGradedPrice: approved picks grade at best price', () => {
  assert.strictEqual(selectGradedPrice('approved', -110, -105), -105);
  assert.strictEqual(selectGradedPrice('approved', -110, 120), 120);
});

test('selectGradedPrice: tracking_only picks keep median, unchanged', () => {
  assert.strictEqual(selectGradedPrice('tracking_only', -110, 120), -110);
  assert.strictEqual(selectGradedPrice('tracking_only', -110, -105), -110);
});

test('selectGradedPrice: falls back to median when bestOdds is unusable', () => {
  assert.strictEqual(selectGradedPrice('approved', -110, null), -110);
  assert.strictEqual(selectGradedPrice('approved', -110, undefined), -110);
  assert.strictEqual(selectGradedPrice('approved', -110, NaN), -110);
});

test('selectGradedPrice: unknown/missing approval status defaults to median (safe)', () => {
  assert.strictEqual(selectGradedPrice(undefined, -110, 120), -110);
  assert.strictEqual(selectGradedPrice('', -110, 120), -110);
});
