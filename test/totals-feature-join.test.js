'use strict';
// 2026-09-10 — why totals had no feature vectors.
//
// generateTotalPick sets betType to the DIRECTION ('over'/'under'), but the
// ledger keys its pick_id map on the MARKET ('total'). So every total looked up
// "over|away@home" against a map holding only "total|away@home", missed, and was
// written with a null pick_id. Moneyline and spread matched by luck — for those
// two, betType and market are the same word.
//
// The damage was silent and total: 127 of 127 MLB total picks since 2026-08-31
// were unjoinable, so feature->CLV attribution could not see a third of the
// slate, and specifically could not see the market the 2026-08-31 analysis
// called the worst performer.
//
// The headline test is `over and under both key to the total market`. If that
// ever goes red, totals are invisible to attribution again and nothing at
// runtime will say so.
const test = require('node:test');
const assert = require('node:assert');
const { featureMarketKey } = require('../src/predictions');

test('over and under both key to the total market', () => {
  assert.strictEqual(featureMarketKey('over'), 'total');
  assert.strictEqual(featureMarketKey('under'), 'total');
  assert.strictEqual(featureMarketKey('Over'), 'total', 'case must not matter');
  assert.strictEqual(featureMarketKey('UNDER'), 'total');
});

test('moneyline and spread are passed through unchanged', () => {
  assert.strictEqual(featureMarketKey('moneyline'), 'moneyline');
  assert.strictEqual(featureMarketKey('spread'), 'spread');
});

test('an unknown or empty betType does not become a total', () => {
  // Silently mapping anything unrecognised onto 'total' would attribute a
  // stray pick's CLV to the total market — worse than failing to join.
  assert.strictEqual(featureMarketKey(''), '');
  assert.strictEqual(featureMarketKey(undefined), '');
  assert.strictEqual(featureMarketKey(null), '');
  assert.strictEqual(featureMarketKey('prop'), 'prop');
});

test('the join key it builds matches the one the ledger writes', () => {
  // The ledger side builds `${market}|${away}@${home}` (predictions.js, where
  // pickIdByFeatureKey is populated). This reproduces both sides and asserts
  // they meet — the actual bug was that they did not.
  const away = 'Colorado Rockies', home = 'San Francisco Giants';
  const ledgerKey = `total|${away}@${home}`;
  const featureKey = `${featureMarketKey('under')}|${away}@${home}`;
  assert.strictEqual(featureKey, ledgerKey);
});
