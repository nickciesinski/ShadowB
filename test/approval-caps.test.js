'use strict';
// 2026-10-31 — edge cap and tracking-only segments are guards: they can only
// move a pick to tracking-only, never drop it or change its side.
const test = require('node:test');
const assert = require('node:assert');
const { shouldApprove, getThresholds } = require('../src/approval-engine');

const base = { confidence: 6, _mktQuality: 0.9, _dataCompleteness: 0.9, _uncertainty: 0.2 };

test('NHL: a 25-pt claimed edge is capped; 8 pts is fine', () => {
  const t = getThresholds('NHL');
  assert.strictEqual(shouldApprove({ ...base, betType: 'spread', _edge: 25, _odds: -110 }, t, 'NHL').approved, false);
  assert.strictEqual(shouldApprove({ ...base, betType: 'spread', _edge: 8, _odds: -110 }, t, 'NHL').approved, true);
});

test('NHL: moneyline underdogs are tracking-only, favourites are not', () => {
  const t = getThresholds('NHL');
  assert.strictEqual(shouldApprove({ ...base, betType: 'moneyline', _edge: 8, _odds: 135 }, t, 'NHL').approved, false);
  assert.strictEqual(shouldApprove({ ...base, betType: 'moneyline', _edge: 8, _odds: -140 }, t, 'NHL').approved, true);
});

test('NBA: totals are tracking-only; spreads are uncapped', () => {
  const t = getThresholds('NBA');
  assert.strictEqual(shouldApprove({ ...base, betType: 'total', _edge: 8, _odds: -110 }, t, 'NBA').approved, false);
  assert.strictEqual(shouldApprove({ ...base, betType: 'spread', _edge: 28, _odds: -110 }, t, 'NBA').approved, true);
});

test('NFL: cap at 30 pts', () => {
  const t = getThresholds('NFL');
  assert.strictEqual(shouldApprove({ ...base, betType: 'spread', _edge: 31, _odds: -110 }, t, 'NFL').approved, false);
  assert.strictEqual(shouldApprove({ ...base, betType: 'spread', _edge: 22, _odds: -110 }, t, 'NFL').approved, true);
});
