'use strict';
// 2026-11-16 — sizing uses the edge pulled halfway to the market.
const test = require('node:test');
const assert = require('node:assert');
const { sizingEdge, shrinkShare, calcUnits } = require('../src/market-pricing');

test('shipped config halves the edge used for sizing in every US league', () => {
  for (const lg of ['NHL', 'NBA', 'NFL', 'MLB']) assert.strictEqual(shrinkShare(lg), 0.5);
  assert.strictEqual(sizingEdge(8, 'NHL'), 4);
  assert.strictEqual(sizingEdge(-3, 'NBA'), 0);
});

test('a smaller sizing edge means a smaller stake, never below the floor', () => {
  const full = calcUnits(8, 0.2, 0.9, 1, 1);
  const half = calcUnits(sizingEdge(8, 'NHL'), 0.2, 0.9, 1, 1);
  assert.ok(half < full);
  assert.ok(calcUnits(sizingEdge(0.1, 'NHL'), 0.2, 0.9, 1, 1) >= 0.01);
});
