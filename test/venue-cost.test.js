'use strict';
// 2026-08-31 — venue cost model. The tests that matter most are the ones
// pinning that an unknown venue returns null rather than 0: rendering "we
// don't know" as "free" would make a venue look profitable out of ignorance.
const test = require('node:test');
const assert = require('node:assert');
const { venueCost, netEdgeAtVenue, loadVenues } = require('../src/venue-cost');

const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('Kalshi taker follows 0.07 * P * (1-P) and peaks at 0.50', () => {
  assert.ok(near(venueCost('kalshi', 0.5), 0.0175));
  assert.ok(near(venueCost('kalshi', 0.4), 0.07 * 0.4 * 0.6));
  // peak at even money
  assert.ok(venueCost('kalshi', 0.5) > venueCost('kalshi', 0.3));
  assert.ok(venueCost('kalshi', 0.5) > venueCost('kalshi', 0.8));
});

test('Kalshi maker is a quarter of taker', () => {
  assert.ok(near(venueCost('kalshi', 0.5, 'maker'), 0.004375));
  assert.ok(near(venueCost('kalshi', 0.5, 'maker') * 4, venueCost('kalshi', 0.5, 'taker')));
});

test('Novig taker applies the per-contract cap', () => {
  // uncapped at 0.5 would be 0.0075 exactly - the cap binds at/above it
  assert.ok(near(venueCost('novig', 0.5), 0.0075));
  assert.ok(venueCost('novig', 0.35) < 0.0075);
  assert.strictEqual(venueCost('novig', 0.5, 'maker'), 0);
});

test('Kalshi taker is MORE expensive than the book we already use', () => {
  // the counterintuitive result the whole venue question turns on:
  // measured sportsbook cost on rule C is ~0.0114
  assert.ok(venueCost('kalshi', 0.42) > 0.0114, 'Kalshi taker should exceed measured book vig');
  assert.ok(venueCost('novig', 0.42) < 0.0114, 'Novig taker should beat measured book vig');
});

test('unknown or unmodelled venues return null, never zero', () => {
  assert.strictEqual(venueCost('dk_predictions', 0.5), null);   // model: unknown
  assert.strictEqual(venueCost('sportsbook', 0.5), null);       // model: measured
  assert.strictEqual(venueCost('betfair', 0.5), null);          // not in config
  assert.strictEqual(venueCost('', 0.5), null);
  assert.strictEqual(venueCost(null, 0.5), null);
});

test('absurd prices return null rather than a fabricated fee', () => {
  for (const p of [0, 1, -0.2, 1.5, NaN, null, undefined, 'abc']) {
    assert.strictEqual(venueCost('kalshi', p), null, `price ${p} should not price`);
  }
});

test('netEdgeAtVenue subtracts cost from CLV and propagates nulls', () => {
  assert.ok(near(netEdgeAtVenue(0.0072, 'novig', 0.5, 'maker'), 0.0072));
  assert.ok(near(netEdgeAtVenue(0.0072, 'novig', 0.5, 'taker'), 0.0072 - 0.0075));
  assert.strictEqual(netEdgeAtVenue(null, 'novig', 0.5), null);
  assert.strictEqual(netEdgeAtVenue(0.0072, 'dk_predictions', 0.5), null);
});

test('an unreadable config prices nothing', () => {
  assert.strictEqual(loadVenues('/nonexistent-dir-for-test'), null);
  assert.strictEqual(venueCost('kalshi', 0.5, 'taker', null), null);
});

test('every configured venue declares a confidence, so none reads as certain by default', () => {
  const v = loadVenues();
  for (const [k, spec] of Object.entries(v)) {
    if (spec.model === 'quadratic') {
      assert.ok(spec.confidence, `${k} must declare confidence`);
    }
  }
});
