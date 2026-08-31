'use strict';
// 2026-08-31 — the numbers the app shows.
// The tests that matter: confidence is a scale over REAL edge, not a
// percentile (a percentile would hand 10/10 to the best of a bad slate — the
// same fiction in a new coat), and an uncalibrated row is reported as
// uncalibrated rather than quietly showing the raw number.
const test = require('node:test');
const assert = require('node:assert');

let M;
test.before(async () => { M = await import('../src/calibrated-display.mjs'); });

const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('impliedProb handles both sides and rejects junk', () => {
  assert.ok(near(M.impliedProb(100), 0.5));
  assert.ok(near(M.impliedProb(-110), 110 / 210));
  assert.strictEqual(M.impliedProb(-1), null, 'the close_odds=-1 class of bad price');
  assert.strictEqual(M.impliedProb(0), null);
  assert.strictEqual(M.impliedProb('x'), null);
});

test('edge is measured against the best price we could actually take', () => {
  // logged -105 but +120 available -> judged on +120
  const e = M.calibratedEdge(0.50, -105, 120);
  assert.ok(near(e, 0.50 - (100 / 220)));
  // no best price -> falls back to the logged one
  assert.ok(near(M.calibratedEdge(0.50, 100, null), 0.0));
});

test('a typical measured pick shows negative edge — that is the finding', () => {
  // median calibrated prob sits ~3pp below the price implied
  const e = M.calibratedEdge(0.48, -110);
  assert.ok(e < 0, `expected negative, got ${e}`);
  assert.strictEqual(M.calibratedConfidence(e), 1);
  assert.strictEqual(M.calibratedUnits(1), 0.01);
});

test('confidence scales on real edge, not on rank', () => {
  assert.strictEqual(M.calibratedConfidence(-0.05), 1);
  assert.strictEqual(M.calibratedConfidence(0), 1);
  assert.strictEqual(M.calibratedConfidence(0.02), 10);
  assert.strictEqual(M.calibratedConfidence(0.10), 10, 'clamped, never above 10');
  const mid = M.calibratedConfidence(0.01);
  assert.ok(mid > 4 && mid < 7, `half the edge should be mid-scale, got ${mid}`);
  // strictly monotone across the usable range
  assert.ok(M.calibratedConfidence(0.005) < M.calibratedConfidence(0.015));
});

test('units run from the minimum to the cap and never hit zero', () => {
  assert.strictEqual(M.calibratedUnits(1), 0.01);
  assert.strictEqual(M.calibratedUnits(10), 0.5);
  assert.ok(M.calibratedUnits(5) > 0.01 && M.calibratedUnits(5) < 0.5);
  assert.ok(M.calibratedUnits(1) > 0, 'a no-edge pick still shows, at minimum stake');
});

test('displayFor reports an uncalibrated row as uncalibrated', () => {
  // EPL today: no fitted map, so calibrated_prob is null
  const d = M.displayFor({ calibrated_prob: null, odds: -110, best_odds: -105 });
  assert.deepStrictEqual(d, { calibrated: false, edge: null, confidence: null, units: null });
  // and it must not fall back to anything raw
  assert.strictEqual(d.confidence, null);
});

test('displayFor returns a coherent set for a calibrated row', () => {
  const d = M.displayFor({ calibrated_prob: 0.55, odds: 100, best_odds: 110 });
  assert.strictEqual(d.calibrated, true);
  assert.ok(d.edge > 0);
  assert.ok(d.confidence >= 1 && d.confidence <= 10);
  assert.ok(d.units >= 0.01 && d.units <= 0.5);
});

test('a bad price cannot produce a confident pick', () => {
  const d = M.displayFor({ calibrated_prob: 0.9, odds: -1, best_odds: null });
  assert.strictEqual(d.calibrated, false, 'invalid price must not price a bet');
});
