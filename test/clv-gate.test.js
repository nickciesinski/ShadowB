'use strict';
// R1.3: CLV-beat staking gate. Pins the pure gate decision offline so the
// live approval-engine wiring stays a guard-only, additive change. The
// shipped config (config/clv-gate.json) is enabled:false, so these tests
// exercise the logic against explicit in-memory configs.
const test = require('node:test');
const assert = require('node:assert');
const { isSegmentGated, normMarket, loadGateConfig } = require('../src/clv-gate');

const nhlGateOn = {
  enabled: true,
  gated_segments: [{ league: 'NHL', market: '*', evidence: 'CLV -3.38pp (n=24)' }],
};

test('disabled config is always a no-op, even for a listed segment', () => {
  const cfg = { ...nhlGateOn, enabled: false };
  assert.strictEqual(isSegmentGated('NHL', 'spread', cfg).gated, false);
  // Missing enabled flag also = inert.
  assert.strictEqual(isSegmentGated('NHL', 'spread', { gated_segments: nhlGateOn.gated_segments }).gated, false);
});

test('wildcard market gates every market in the listed league', () => {
  for (const mk of ['moneyline', 'spread', 'total']) {
    const r = isSegmentGated('NHL', mk, nhlGateOn);
    assert.strictEqual(r.gated, true, `NHL ${mk} should gate`);
    assert.match(r.reason, /CLV-gate:/);
  }
});

test('leagues not in the list are never gated (MLB workhorse protected)', () => {
  for (const mk of ['moneyline', 'spread', 'total']) {
    assert.strictEqual(isSegmentGated('MLB', mk, nhlGateOn).gated, false);
  }
  assert.strictEqual(isSegmentGated('NBA', 'spread', nhlGateOn).gated, false);
});

test('market-specific entries gate only that market', () => {
  const cfg = {
    enabled: true,
    gated_segments: [{ league: 'MLB', market: 'spread', evidence: 'x' }],
  };
  assert.strictEqual(isSegmentGated('MLB', 'spread', cfg).gated, true);
  assert.strictEqual(isSegmentGated('MLB', 'moneyline', cfg).gated, false);
  assert.strictEqual(isSegmentGated('MLB', 'total', cfg).gated, false);
});

test('league and market matching is case-insensitive', () => {
  assert.strictEqual(isSegmentGated('nhl', 'SPREAD', nhlGateOn).gated, true);
  const cfg = { enabled: true, gated_segments: [{ league: 'mlb', market: 'Spread' }] };
  assert.strictEqual(isSegmentGated('MLB', 'spread', cfg).gated, true);
});

test('empty-string market behaves like wildcard', () => {
  const cfg = { enabled: true, gated_segments: [{ league: 'NHL', market: '' }] };
  assert.strictEqual(isSegmentGated('NHL', 'total', cfg).gated, true);
});

test('malformed / empty inputs fail safe (not gated)', () => {
  assert.strictEqual(isSegmentGated('NHL', 'spread', null).gated, false);
  assert.strictEqual(isSegmentGated('NHL', 'spread', {}).gated, false);
  assert.strictEqual(isSegmentGated('NHL', 'spread', { enabled: true }).gated, false);
  assert.strictEqual(isSegmentGated('NHL', 'spread', { enabled: true, gated_segments: 'x' }).gated, false);
  assert.strictEqual(isSegmentGated('', 'spread', nhlGateOn).gated, false);
  assert.strictEqual(isSegmentGated(undefined, undefined, nhlGateOn).gated, false);
});

test('normMarket lowercases and trims', () => {
  assert.strictEqual(normMarket('  Spread '), 'spread');
  assert.strictEqual(normMarket(null), '');
});

test('shipped config parses and is inert (enabled:false)', () => {
  const cfg = loadGateConfig();
  assert.strictEqual(cfg.enabled, false, 'shipped config must default OFF');
  // Even though NHL is pre-listed, disabled => no gating.
  assert.strictEqual(isSegmentGated('NHL', 'spread', cfg).gated, false);
});
