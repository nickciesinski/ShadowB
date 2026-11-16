'use strict';
// R5.1(c): out-of-sample apply gate for the weekly threshold tuner.
// Guard only: it may remove a LOOSENING change, never a tightening one,
// never add or enlarge a change, and ships inert.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const gate = require('../src/threshold-oos-gate');
const { decideLeagueChange } = require('../scripts/weekly-threshold-tune');

const ON = { enabled: true, minSample: 50, minRoiPct: 0, minClvPp: 0, minNetEdgePp: 0 };
const OFF = { ...ON, enabled: false };
const current = { minEdgePct: 2.5, minConfidence: 4, maxUncertainty: 0.75 };

const goodHoldout = { decided: 120, staked: 30, roiPct: 4.2, clvN: 110, avgClvPp: 0.6, netEdgeN: 110, avgNetEdgePp: 0.2 };
const badNetEdge = { ...goodHoldout, avgNetEdgePp: -1.5 };

const loosen = { changes: { minEdgePct: 2.0 }, reasons: ['loosen'], note: null };
const tighten = { changes: { minEdgePct: 3.0, minConfidence: 5 }, reasons: ['tighten'], note: null };

test('shipped config/threshold-oos-gate.json is inert (enabled=false)', () => {
  const cfg = gate.loadGateConfig(path.join(__dirname, '..', 'config', 'threshold-oos-gate.json'));
  assert.strictEqual(cfg.enabled, false);
});

test('missing config file -> disabled default (never blocks on config error)', () => {
  const cfg = gate.loadGateConfig(path.join(__dirname, 'nope-threshold-oos.json'));
  assert.strictEqual(cfg.enabled, false);
});

test('inert: loosening passes through unchanged, review says what it would do', () => {
  const d = gate.applyGate(loosen, current, badNetEdge, OFF);
  assert.deepStrictEqual(d.changes, { minEdgePct: 2.0 });
  assert.match(d.oos, /inert — would BLOCK/);
});

test('enabled + holdout proves edge -> loosening allowed', () => {
  const d = gate.applyGate(loosen, current, goodHoldout, ON);
  assert.deepStrictEqual(d.changes, { minEdgePct: 2.0 });
  assert.match(d.oos, /allowed/);
});

test('enabled + negative net edge in holdout -> loosening removed', () => {
  const d = gate.applyGate(loosen, current, badNetEdge, ON);
  assert.deepStrictEqual(d.changes, {});
  assert.match(d.note, /out-of-sample/);
  assert.ok(d.reasons.some(r => /OOS gate blocked/.test(r)));
});

test('enabled + +ROI but negative CLV in holdout -> blocked (variance, not edge)', () => {
  const d = gate.applyGate(loosen, current, { ...goodHoldout, avgClvPp: -0.4 }, ON);
  assert.deepStrictEqual(d.changes, {});
});

test('enabled + thin holdout sample -> blocked (no proof)', () => {
  const d = gate.applyGate(loosen, current, { ...goodHoldout, decided: 12 }, ON);
  assert.deepStrictEqual(d.changes, {});
});

test('enabled + negative holdout ROI -> blocked', () => {
  const d = gate.applyGate(loosen, current, { ...goodHoldout, roiPct: -3 }, ON);
  assert.deepStrictEqual(d.changes, {});
});

test('tightening is NEVER blocked, even with terrible holdout', () => {
  const d = gate.applyGate(tighten, current, { decided: 0, roiPct: null }, ON);
  assert.deepStrictEqual(d.changes, { minEdgePct: 3.0, minConfidence: 5 });
  assert.strictEqual(d.oos, null);
});

test('mixed change: loosening key stripped, tightening key kept', () => {
  const mixed = { changes: { minEdgePct: 3.0, maxUncertainty: 0.85 }, reasons: [] };
  const d = gate.applyGate(mixed, current, badNetEdge, ON);
  assert.deepStrictEqual(d.changes, { minEdgePct: 3.0 });
});

test('gate never adds or enlarges a change; input not mutated', () => {
  const input = { changes: { minEdgePct: 2.0 }, reasons: ['x'] };
  const snap = JSON.stringify(input);
  for (const h of [goodHoldout, badNetEdge, null]) {
    for (const cfg of [ON, OFF]) {
      const d = gate.applyGate(input, current, h, cfg);
      for (const [k, v] of Object.entries(d.changes)) assert.strictEqual(v, input.changes[k]);
      assert.ok(Object.keys(d.changes).length <= 1);
    }
  }
  assert.strictEqual(JSON.stringify(input), snap);
});

test('classifyChanges: direction per key', () => {
  const c = gate.classifyChanges(
    { minEdgePct: 2.0, minConfidence: 5, maxUncertainty: 0.8, maxEdgePct: 15 },
    { minEdgePct: 2.5, minConfidence: 4, maxUncertainty: 0.75, maxEdgePct: 20 });
  assert.deepStrictEqual(c.loosen.sort(), ['maxUncertainty', 'minEdgePct']);
  assert.deepStrictEqual(c.tighten.sort(), ['maxEdgePct', 'minConfidence']);
});

test('holdoutStats: approved-only, [from,to) window, league filter, CLV/net edge averages', () => {
  function row(date, lg, appr, res, units, ret, clv, ne) {
    const r = new Array(39).fill('');
    r[0] = date; r[1] = lg; r[21] = appr; r[16] = res; r[10] = units; r[17] = ret;
    if (clv != null) r[33] = clv; if (ne != null) r[35] = ne;
    return r;
  }
  const from = new Date(2026, 9, 17), to = new Date(2026, 10, 9);
  const rows = [
    row('10/20/2026', 'MLB', 'approved', 'W', 1, 0.9, 1.0, -0.5),
    row('10/25/2026', 'MLB', 'approved', 'L', 1, -1, -0.2, -2.1),
    row('11/1/2026', 'MLB', 'approved', 'P', 1, 0, null, null),
    row('11/1/2026', 'MLB', 'tracking_only', 'W', 1, 0.9, 5, 5),   // not approved
    row('11/10/2026', 'MLB', 'approved', 'W', 1, 0.9, 5, 5),       // decision window
    row('10/10/2026', 'MLB', 'approved', 'W', 1, 0.9, 5, 5),       // too old
    row('10/20/2026', 'NHL', 'approved', 'W', 1, 0.9, 5, 5),       // other league
    row('10/21/2026', 'MLB', 'approved', '', 1, 0, 5, 5),          // ungraded
  ];
  const h = gate.holdoutStats(rows, 'MLB', from, to);
  assert.strictEqual(h.decided, 2);
  assert.strictEqual(h.staked, 3);
  assert.strictEqual(h.roiPct, -3.3);
  assert.strictEqual(h.clvN, 2);
  assert.strictEqual(h.avgClvPp, 0.4);
  assert.strictEqual(h.avgNetEdgePp, -1.3);
});

test('end-to-end with tuner decision: +ROI 7d loosen is held when days 8-30 are net-edge negative', () => {
  const seg = (roiPct, graded) => ({ all: { roiPct, graded }, approved: { roiPct, graded }, tracking: { roiPct: 0, graded: 0 } });
  const d0 = decideLeagueChange('MLB', seg(21, 200), seg(5, 600), current, { n: 190, beatPct: 55, avgPts: 0.3 });
  assert.strictEqual(d0.changes.minEdgePct, 2.0, 'tuner wants to loosen');
  const d = gate.applyGate(d0, current, badNetEdge, ON);
  assert.deepStrictEqual(d.changes, {});
});
