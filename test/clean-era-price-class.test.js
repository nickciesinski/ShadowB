'use strict';
// 2026-08-31 — price-class split in the clean-era report.
//
// Why this exists: the measured loss on MLB is concentrated entirely on the
// favourite side (books hold ~2x there, and our CLV flips sign across it).
// The report could not show that, so the split was invisible. These tests pin
// the bucketing, the staked-only scope, and the net-edge averaging offline.
const test = require('node:test');
const assert = require('node:assert');
const { priceClassOf, priceSegments, priceTable } = require('../scripts/clean-era-report');

// Positional row shape from supaRowsToArrayRows (36 wide).
// 0 date, 1 league, 2 market, 9 odds, 10 units, 16 result, 17 return,
// 21 approval, 33 clv pts, 34 vig pp, 35 net edge pp.
function row({ date = '8/15/2026', league = 'MLB', market = 'moneyline', odds = -110,
               units = 1, result = 'W', ret = 0.91, approval = 'approved',
               clv = null, vig = null, net = null } = {}) {
  const r = new Array(36).fill('');
  r[0] = date; r[1] = league; r[2] = market; r[9] = odds; r[10] = units;
  r[16] = result; r[17] = ret; r[21] = approval;
  if (clv !== null) r[33] = clv;
  if (vig !== null) r[34] = vig;
  if (net !== null) r[35] = net;
  return r;
}
const CUT = new Date(2026, 5, 3);

test('priceClassOf splits at +100 and rejects junk', () => {
  assert.strictEqual(priceClassOf(100), 'plus_money');
  assert.strictEqual(priceClassOf(250), 'plus_money');
  assert.strictEqual(priceClassOf(-110), 'minus_money');
  assert.strictEqual(priceClassOf(-100), 'minus_money');
  assert.strictEqual(priceClassOf(''), null);
  assert.strictEqual(priceClassOf(0), null);
  assert.strictEqual(priceClassOf('abc'), null);
});

test('buckets staked rows by price class and averages the measurement columns', () => {
  const seg = priceSegments([
    row({ odds: 150, result: 'W', ret: 1.5, clv: 0.8, vig: 0.8, net: 0.0 }),
    row({ odds: 200, result: 'L', ret: -1, clv: 0.6, vig: 0.9, net: -0.3 }),
    row({ odds: -150, result: 'L', ret: -1, clv: -0.4, vig: 1.8, net: -2.2 }),
  ], CUT);
  const plus = seg.MLB.plus_money, minus = seg.MLB.minus_money;
  assert.strictEqual(plus.n, 2);
  assert.strictEqual(minus.n, 1);
  assert.strictEqual(plus.w, 1);
  assert.strictEqual(plus.l, 1);
  // net edge averages over only the rows that carry it
  assert.ok(Math.abs(plus.neSum / plus.neN - (-0.15)) < 1e-9);
  assert.ok(Math.abs(minus.neSum / minus.neN - (-2.2)) < 1e-9);
  // staked / return roll up
  assert.strictEqual(plus.staked, 2);
  assert.ok(Math.abs(plus.ret - 0.5) < 1e-9);
});

test('tracking-only rows are excluded — this is the money question', () => {
  const seg = priceSegments([
    row({ odds: 150, approval: 'tracking_only' }),
    row({ odds: 150, approval: 'approved' }),
  ], CUT);
  assert.strictEqual(seg.MLB.plus_money.n, 1);
});

test('rows before the cutoff and ungraded rows are excluded', () => {
  const seg = priceSegments([
    row({ date: '5/01/2026', odds: 150 }),          // pre clean era
    row({ odds: 150, result: '' }),                  // ungraded
    row({ odds: 150, result: 'P', ret: 0 }),         // push counts as decided
  ], CUT);
  assert.strictEqual(seg.MLB.plus_money.n, 1);
  assert.strictEqual(seg.MLB.plus_money.p, 1);
});

test('missing measurement columns degrade to a dash, never to zero', () => {
  const seg = priceSegments([row({ odds: 150, clv: null, vig: null, net: null })], CUT);
  assert.strictEqual(seg.MLB.plus_money.neN, 0);
  const md = priceTable(seg, 'x');
  assert.ok(md.includes('—'), 'empty measurement renders as em dash');
  assert.ok(!md.includes('+0.00pp'), 'must not report a fabricated zero');
});

test('priceTable renders a row per populated class and stays empty-safe', () => {
  const md = priceTable(priceSegments([], CUT), 'empty');
  assert.ok(md.includes('| — | — | 0 |'));
});
