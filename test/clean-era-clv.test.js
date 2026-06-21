'use strict';
// R1.1: CLV computation in the clean-era report is read-only (our odds col 9 vs
// closing odds col 31). These tests pin the math + bucketing offline.
const test = require('node:test');
const assert = require('node:assert');
const { impliedProb, clvPoints, clvSegments, clvFinalize } = require('../scripts/clean-era-report');

test('impliedProb handles favorites, dogs, and junk', () => {
  assert.ok(Math.abs(impliedProb(-110) - 0.5238) < 0.001);
  assert.ok(Math.abs(impliedProb(+100) - 0.5) < 1e-9);
  assert.ok(Math.abs(impliedProb(+200) - 0.3333) < 0.001);
  assert.strictEqual(impliedProb(''), null);
  assert.strictEqual(impliedProb(0), null);
});

test('clvPoints positive when the close implies more prob on our side (we beat it)', () => {
  // We took +120, line closed at -110 (market moved to our side) -> beat close.
  assert.ok(clvPoints(120, -110) > 0);
  // We took -110, closed at +120 (moved away) -> negative CLV.
  assert.ok(clvPoints(-110, 120) < 0);
  // Same price -> ~0.
  assert.ok(Math.abs(clvPoints(-110, -110)) < 1e-9);
  // Missing closing odds -> null (excluded from CLV).
  assert.strictEqual(clvPoints(-110, ''), null);
});

function row(date, lg, mk, odds, closeOdds, appr) {
  const r = new Array(34).fill('');
  r[0] = date; r[1] = lg; r[2] = mk; r[9] = odds; r[21] = appr; r[31] = closeOdds;
  return r;
}

test('clvSegments buckets by approval, excludes pre-clean-era and no-close rows', () => {
  const rows = [
    row('6/10/2026', 'MLB', 'moneyline', 120, -110, 'approved'), // beat
    row('6/11/2026', 'MLB', 'moneyline', -110, 120, 'approved'), // lost CLV
    row('6/12/2026', 'MLB', 'moneyline', -105, -110, 'tracking_only'), // beat, tracking
    row('6/12/2026', 'MLB', 'moneyline', -110, '', 'approved'), // no close -> excluded
    row('5/01/2026', 'MLB', 'moneyline', 200, -110, 'approved'), // pre-clean-era -> excluded
  ];
  const seg = clvSegments(rows, new Date(2026, 5, 3));
  const appr = clvFinalize(seg.MLB.approved);
  assert.strictEqual(appr.n, 2, 'only 2 approved rows have a close + are in era');
  assert.strictEqual(appr.beatPct, 50, '1 of 2 approved beat the close');
  const trk = clvFinalize(seg.MLB.tracking);
  assert.strictEqual(trk.n, 1);
  assert.strictEqual(trk.beatPct, 100);
});
