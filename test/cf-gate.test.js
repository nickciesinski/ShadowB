'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  loadGateConfig,
  evaluateCounterfactualGate,
  sampleFromRecord,
  DEFAULT_CONFIG,
} = require('../src/cf-gate');

// A counterfactual summary that clearly clears the default gate.
function goodSummary() {
  return {
    baseline: { record: '130-76', winRate: 63.1, netUnits: 10.0, totalRisked: 75, roi: 20.0 },
    proposed: { record: '135-71', winRate: 65.5, netUnits: 14.0, totalRisked: 75, roi: 24.0 },
    diff: { winRate: 2.4, roi: 4.0, netUnits: 4.0 },
  };
}

const ENABLED = { enabled: true, minSample: 50, minRoiLift: 0, minNetUnitsLift: 0 };

// ── sampleFromRecord ────────────────────────────────────────────
test('sampleFromRecord parses W-L', () => {
  assert.strictEqual(sampleFromRecord('130-76'), 206);
});
test('sampleFromRecord ignores pushes in W-L-T', () => {
  assert.strictEqual(sampleFromRecord('4-6-2'), 10);
});
test('sampleFromRecord returns 0 on junk', () => {
  assert.strictEqual(sampleFromRecord('n/a'), 0);
  assert.strictEqual(sampleFromRecord(null), 0);
  assert.strictEqual(sampleFromRecord(undefined), 0);
});

// ── disabled = inert no-op (never blocks, even with no data) ─────
test('disabled gate is a pass-through no-op', () => {
  const r = evaluateCounterfactualGate(null, { ...DEFAULT_CONFIG });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.gated, false);
});
test('disabled gate passes even a losing counterfactual', () => {
  const s = goodSummary();
  s.diff.roi = -9; s.diff.netUnits = -5;
  const r = evaluateCounterfactualGate(s, { ...DEFAULT_CONFIG });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.gated, false);
});

// ── enabled: requires valid proof of OOS lift ───────────────────
test('enabled gate blocks when counterfactual is null', () => {
  const r = evaluateCounterfactualGate(null, ENABLED);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.gated, true);
});
test('enabled gate blocks when summary is malformed', () => {
  const r = evaluateCounterfactualGate({ baseline: { record: '1-1' } }, ENABLED); // no diff
  assert.strictEqual(r.pass, false);
});
test('enabled gate blocks when sample below minSample', () => {
  const s = goodSummary();
  s.baseline.record = '20-10'; // n=30 < 50
  const r = evaluateCounterfactualGate(s, ENABLED);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.sample, 30);
});
test('enabled gate blocks on negative ROI lift', () => {
  const s = goodSummary();
  s.diff.roi = -0.1;
  const r = evaluateCounterfactualGate(s, ENABLED);
  assert.strictEqual(r.pass, false);
});
test('enabled gate blocks on negative net-units lift', () => {
  const s = goodSummary();
  s.diff.netUnits = -0.5;
  const r = evaluateCounterfactualGate(s, ENABLED);
  assert.strictEqual(r.pass, false);
});
test('enabled gate PASSES when OOS lift clears the floor', () => {
  const r = evaluateCounterfactualGate(goodSummary(), ENABLED);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.gated, true);
  assert.strictEqual(r.sample, 206);
  assert.strictEqual(r.roiLift, 4);
  assert.strictEqual(r.netUnitsLift, 4);
});
test('exactly-at-floor lift passes (>=, not >)', () => {
  const s = goodSummary();
  s.diff.roi = 0; s.diff.netUnits = 0;
  const r = evaluateCounterfactualGate(s, ENABLED);
  assert.strictEqual(r.pass, true);
});

// ── config loading ──────────────────────────────────────────────
test('shipped config/cf-gate.json is inert (enabled=false)', () => {
  const cfg = loadGateConfig(path.join(__dirname, '..', 'config', 'cf-gate.json'));
  assert.strictEqual(cfg.enabled, false);
});
test('missing config file fails safe to disabled default', () => {
  const cfg = loadGateConfig(path.join(__dirname, 'does-not-exist-cf-gate.json'));
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.minSample, DEFAULT_CONFIG.minSample);
});
