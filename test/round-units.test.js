'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { roundUnits, calcUnits } = require('../src/market-pricing');

test('rounds long floats to 2 decimals (the reported 0.24194051 case)', () => {
  assert.strictEqual(roundUnits(0.24194051), 0.24);
  assert.strictEqual(roundUnits(0.247), 0.25);
  assert.strictEqual(roundUnits(0.245), 0.25); // round half up
});

test('never returns below the 0.01 floor', () => {
  assert.strictEqual(roundUnits(0.004), 0.01); // would round to 0.00 -> floored
  assert.strictEqual(roundUnits(0.005), 0.01);
  assert.strictEqual(roundUnits(0), 0.01);
  assert.strictEqual(roundUnits(-1), 0.01);
});

test('non-finite input falls back to the floor', () => {
  assert.strictEqual(roundUnits(NaN), 0.01);
  assert.strictEqual(roundUnits(Infinity), 0.01);
  assert.strictEqual(roundUnits(undefined), 0.01);
});

test('already-2dp and exact values pass through unchanged', () => {
  assert.strictEqual(roundUnits(0.25), 0.25);
  assert.strictEqual(roundUnits(0.5), 0.5);
  assert.strictEqual(roundUnits(0.01), 0.01);
});

test('calcUnits output is always at most 2 decimal places', () => {
  // exercise a spread of edges; result should equal its own 2dp rounding
  for (const edge of [0.3, 1.1, 2.7, 4.9, 7.3, 12.5]) {
    const u = calcUnits(edge, 0.37, 0.63, 0.94, 1.07);
    assert.strictEqual(u, Math.round(u * 100) / 100);
    assert.ok(u >= 0.01 && u <= 0.5);
  }
});
