'use strict';
// 2026-09-28 — the stake modifier compounded nightly on an overlapping 30-day
// window until it hit the rails. Same data must now give the same answer.
const test = require('node:test');
const assert = require('node:assert');
const { computeModifier } = require('../src/optimize');

test('same stats give the same modifier whatever the current value', () => {
  for (const cur of [0.2, 1.0, 1.5]) {
    assert.strictEqual(computeModifier(cur, 48.4, -13, 405), 0.70, 'MLB spread case');
    assert.strictEqual(computeModifier(cur, 54.5, 8.6, 389), 1.15, 'MLB total case');
  }
});

test('re-running on the same window never drifts', () => {
  let m = 1.0;
  for (let night = 0; night < 30; night++) m = computeModifier(m, 48, -10, 300);
  assert.strictEqual(m, 0.70);
});

test('bands and thin samples', () => {
  assert.strictEqual(computeModifier(0.2, 51, 4, 100), 1.05);
  assert.strictEqual(computeModifier(0.2, 49, -5, 100), 0.85);
  assert.strictEqual(computeModifier(0.2, 51, 0, 100), 1.0);
  assert.strictEqual(computeModifier(0.2, 90, 50, 10), 1.0, 'under MIN_SAMPLE → neutral, not stuck');
});
