'use strict';
// 2026-08-31 (R3.3) — probability calibration.
// The load-bearing tests are the ones proving it never silently falls back to
// the raw value: an uncalibrated number passed off as calibrated would
// reintroduce exactly the fiction this module exists to remove.
const test = require('node:test');
const assert = require('node:assert');
const { calibrate, calibratedEdge, loadCalibration, logit, sigmoid } = require('../src/prob-calibration');

const K = { a: -0.0605, b: 0.0166, c: 1.1079 };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

test('shipped MLB coefficients load', () => {
  const k = loadCalibration('MLB');
  assert.ok(near(k.a, -0.0605) && near(k.b, 0.0166) && near(k.c, 1.1079));
  assert.strictEqual(loadCalibration('mlb').c, k.c, 'league key is case-insensitive');
});

test('reproduces the fitted formula', () => {
  const expected = sigmoid(K.a + K.b * logit(0.83) + K.c * logit(0.576));
  assert.ok(near(calibrate('MLB', 0.83, 0.576, K), expected));
});

test('collapses the fictitious edge — the whole point', () => {
  // The real case from the calibration chart: model says 83%, market says 57.6%,
  // reality delivered 57.4%. Raw claimed edge is +25pp; calibrated should be ~0.
  const raw = 0.83 - 0.576;
  const cal = calibratedEdge('MLB', 0.83, 0.576, K);
  assert.ok(raw > 0.25, 'raw edge really is that large');
  assert.ok(Math.abs(cal) < 0.03, `calibrated edge should be near zero, got ${cal}`);
});

test('tracks the market, not the model', () => {
  // Same model output, different prices -> calibrated output must move with price.
  const lowPrice = calibrate('MLB', 0.83, 0.40, K);
  const highPrice = calibrate('MLB', 0.83, 0.60, K);
  assert.ok(highPrice - lowPrice > 0.15, 'market price drives the answer');
  // Same price, wildly different model output -> barely moves.
  const lowModel = calibrate('MLB', 0.40, 0.50, K);
  const highModel = calibrate('MLB', 0.95, 0.50, K);
  assert.ok(Math.abs(highModel - lowModel) < 0.05, 'model output barely moves it (b~0)');
});

test('output stays a probability', () => {
  for (const [m, q] of [[0.999, 0.99], [0.001, 0.01], [0.5, 0.5], [0.9, 0.1]]) {
    const p = calibrate('MLB', m, q, K);
    assert.ok(p > 0 && p < 1, `${m}/${q} -> ${p}`);
  }
});

test('never falls back to the raw value — returns null instead', () => {
  for (const [m, q] of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [-0.3, 0.5], [1.4, 0.5]]) {
    assert.strictEqual(calibrate('MLB', m, q, K), null, `${m}/${q} must not calibrate`);
  }
  assert.strictEqual(calibrate('MLB', null, 0.5, K), null);
  assert.strictEqual(calibrate('MLB', 0.6, undefined, K), null);
  assert.strictEqual(calibrate('MLB', 'x', 0.5, K), null);
});

test('a league with no fitted map calibrates nothing', () => {
  assert.strictEqual(loadCalibration('EPL'), null);
  assert.strictEqual(calibrate('EPL', 0.6, 0.5), null);
  assert.strictEqual(calibratedEdge('EPL', 0.6, 0.5), null);
  assert.strictEqual(loadCalibration('MLB', '/nonexistent-dir-for-test'), null);
});

test('calibratedEdge is null-safe end to end', () => {
  assert.strictEqual(calibratedEdge('MLB', 0, 0.5, K), null);
  assert.ok(Number.isFinite(calibratedEdge('MLB', 0.6, 0.5, K)));
});
