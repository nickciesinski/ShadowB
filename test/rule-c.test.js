'use strict';
// 2026-08-31 — the pre-registered candidate staking rule.
//
// The point of these tests is as much about what the rule MUST NOT do as what
// it does: it is a labeller, it never guesses, and an unreadable config makes
// it stamp nothing rather than stamp everything eligible.
const test = require('node:test');
const assert = require('node:assert');
const { isRuleCEligible, loadRuleConfig } = require('../src/rule-c');

const CFG = { minAmericanOdds: 100, minDisagreement: 0.0805 };

test('shipped config matches the pre-registered thresholds', () => {
  const c = loadRuleConfig();
  assert.strictEqual(c.minAmericanOdds, 100);
  assert.strictEqual(c.minDisagreement, 0.0805);
});

test('qualifies only when BOTH conditions hold', () => {
  // plus money + big disagreement -> eligible
  assert.strictEqual(isRuleCEligible({ odds: 150, predictedProb: 0.60, marketProb: 0.50 }, CFG), true);
  // plus money, disagreement too small
  assert.strictEqual(isRuleCEligible({ odds: 150, predictedProb: 0.52, marketProb: 0.50 }, CFG), false);
  // big disagreement but laying juice
  assert.strictEqual(isRuleCEligible({ odds: -130, predictedProb: 0.60, marketProb: 0.50 }, CFG), false);
  // neither
  assert.strictEqual(isRuleCEligible({ odds: -130, predictedProb: 0.51, marketProb: 0.50 }, CFG), false);
});

test('boundaries are inclusive, matching the SQL that defined the rule', () => {
  assert.strictEqual(isRuleCEligible({ odds: 100, predictedProb: 0.5805, marketProb: 0.5 }, CFG), true);
  assert.strictEqual(isRuleCEligible({ odds: 99, predictedProb: 0.5805, marketProb: 0.5 }, CFG), false);
  assert.strictEqual(isRuleCEligible({ odds: 100, predictedProb: 0.5804, marketProb: 0.5 }, CFG), false);
});

test('prefers best_odds over the logged price, so the label has one basis', () => {
  // logged the consensus median (-105) but +120 was available -> judged on +120
  assert.strictEqual(
    isRuleCEligible({ odds: -105, bestOdds: 120, predictedProb: 0.60, marketProb: 0.50 }, CFG), true);
  // no bestOdds -> falls back to logged price
  assert.strictEqual(
    isRuleCEligible({ odds: -105, bestOdds: null, predictedProb: 0.60, marketProb: 0.50 }, CFG), false);
});

test('returns null rather than guessing when inputs are missing or absurd', () => {
  assert.strictEqual(isRuleCEligible({ predictedProb: 0.6, marketProb: 0.5 }, CFG), null);
  assert.strictEqual(isRuleCEligible({ odds: 150, marketProb: 0.5 }, CFG), null);
  assert.strictEqual(isRuleCEligible({ odds: 150, predictedProb: 0.6 }, CFG), null);
  assert.strictEqual(isRuleCEligible({ odds: 0, predictedProb: 0.6, marketProb: 0.5 }, CFG), null);
  assert.strictEqual(isRuleCEligible({ odds: 150, predictedProb: 1.4, marketProb: 0.5 }, CFG), null);
  assert.strictEqual(isRuleCEligible({ odds: 150, predictedProb: 0.6, marketProb: 0 }, CFG), null);
});

test('an unreadable config stamps nothing — it must not default to eligible', () => {
  assert.strictEqual(isRuleCEligible({ odds: 150, predictedProb: 0.9, marketProb: 0.1 }, null), null);
  assert.strictEqual(loadRuleConfig('/nonexistent-dir-for-test'), null);
});

test('the rule module exposes no staking surface', () => {
  const mod = require('../src/rule-c');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['isRuleCEligible', 'loadRuleConfig']);
});
