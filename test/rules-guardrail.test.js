'use strict';
// Autopilot blocker #3 (roadmap R5.1): prove the optimizer guardrails actually
// clamp out-of-bounds writes and refuse locked rule-keys. Pure, offline test.
const test = require('node:test');
const assert = require('node:assert');
const { PARAM_BOUNDS, LOCKED_PARAM_KEYS, isLockedKey, clampFactor } = require('../config/rules');

test('clampFactor clamps values above the band max down to max', () => {
  for (const [name, b] of Object.entries(PARAM_BOUNDS)) {
    assert.strictEqual(clampFactor(name, b.max + 100), b.max, `${name} should clamp to max`);
  }
});

test('clampFactor clamps values below the band min up to min', () => {
  for (const [name, b] of Object.entries(PARAM_BOUNDS)) {
    assert.strictEqual(clampFactor(name, b.min - 100), b.min, `${name} should clamp to min`);
  }
});

test('clampFactor leaves in-band values untouched', () => {
  for (const [name, b] of Object.entries(PARAM_BOUNDS)) {
    const mid = (b.min + b.max) / 2;
    assert.strictEqual(clampFactor(name, mid), mid, `${name} mid-band must pass through`);
  }
});

test('clampFactor passes through unknown keys and non-finite values unchanged', () => {
  assert.strictEqual(clampFactor('not_a_real_param', 9999), 9999);
  assert.ok(Number.isNaN(clampFactor('total_market_anchor', NaN)));
});

test('isLockedKey blocks the rule-encoding keys and allows tunables', () => {
  for (const k of LOCKED_PARAM_KEYS) assert.ok(isLockedKey(k), `${k} must be locked`);
  assert.ok(isLockedKey(' param_min_units_to_bet '), 'locked check trims whitespace');
  assert.strictEqual(isLockedKey('total_market_anchor'), false, 'tunable param must not be locked');
  assert.strictEqual(isLockedKey('strength_blend_form'), false);
});

test('every PARAM_BOUNDS band is well-formed (min < max, finite)', () => {
  for (const [name, b] of Object.entries(PARAM_BOUNDS)) {
    assert.ok(Number.isFinite(b.min) && Number.isFinite(b.max), `${name} bounds finite`);
    assert.ok(b.min < b.max, `${name} min must be < max`);
  }
});

test('the stake/coverage rules are locked so the auto-tuner cannot zero out picks', () => {
  assert.ok(isLockedKey('param_min_units_to_bet'));     // stake floor
  assert.ok(isLockedKey('param_force_at_least_one_pick'));// coverage rule
  assert.ok(isLockedKey('param_max_picks_per_day'));    // can't throttle picks
});
