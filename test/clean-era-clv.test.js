'use strict';
// R1.1: CLV computation in the clean-era report is read-only. Two sources:
//   - Supabase (v2_clv): precomputed novig points at col 33 (COL_CLV_PTS)
//   - Sheet (legacy): reconstruct from our odds (col 9) vs closing odds (col 31)
// These tests pin the math + bucketing offline, INCLUDING the precomputed path
// (col 33) whose absence let CLV silently go empty on the Supabase-only report.
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


// A Supabase-shaped row: CLV already computed as points and placed at col 33
// by supaRowsToArrayRows; col 31 (raw closing american price) is ALWAYS empty.
function supaRow(date, lg, mk, clvPts, appr) {
  const r = new Array(34).fill('');
  r[0] = date; r[1] = lg; r[2] = mk; r[9] = -110; r[21] = appr;
  r[33] = clvPts; // number => precomputed novig points
  return r;
}

test('clvSegments reads the precomputed col-33 value for Supabase rows (col 31 empty)', () => {
  // This is the regression that emptied the CLV tables: Supabase rows never
  // populate col 31, so the odds-only calc returned null for every row.
  const rows = [
    supaRow('7/01/2026', 'MLB', 'total', 1.5, 'approved'),   // beat
    supaRow('7/02/2026', 'MLB', 'total', -0.8, 'approved'),  // lost CLV
    supaRow('7/03/2026', 'MLB', 'total', 0.4, 'tracking_only'), // beat, tracking
  ];
  const seg = clvSegments(rows, new Date(2026, 5, 3));
  const appr = clvFinalize(seg.MLB.approved);
  assert.strictEqual(appr.n, 2, 'both approved Supabase rows are counted via col 33');
  assert.strictEqual(appr.beatPct, 50, '1 of 2 approved beat the close');
  assert.ok(Math.abs(appr.avgPts - 0.35) < 1e-9, 'avg of +1.5 and -0.8 = +0.35pp');
  const trk = clvFinalize(seg.MLB.tracking);
  assert.strictEqual(trk.n, 1);
  assert.strictEqual(trk.beatPct, 100);
});

test('clvSegments: precomputed col 33 wins over col 31 when both present', () => {
  // Guard against silent divergence from the tuner: if a row somehow carried
  // both, the precomputed novig points (col 33) is the source of truth.
  const r = new Array(34).fill('');
  r[0] = '7/04/2026'; r[1] = 'MLB'; r[2] = 'moneyline';
  r[9] = -110; r[31] = 120; r[33] = 2.0; r[21] = 'approved';
  const seg = clvSegments([r], new Date(2026, 5, 3));
  const appr = clvFinalize(seg.MLB.approved);
  assert.strictEqual(appr.n, 1);
  assert.ok(Math.abs(appr.avgPts - 2.0) < 1e-9, 'uses col-33 +2.0, not the odds calc');
});

test('clvSegments: mixed Supabase + Sheet rows both counted', () => {
  const rows = [
    supaRow('7/05/2026', 'MLB', 'spread', 1.0, 'approved'),      // Supabase, col 33
    row('7/06/2026', 'MLB', 'spread', 120, -110, 'approved'),    // Sheet, col 9/31
    supaRow('7/07/2026', 'MLB', 'spread', '', 'approved'),       // no CLV -> excluded
  ];
  const seg = clvSegments(rows, new Date(2026, 5, 3));
  const appr = clvFinalize(seg.MLB.approved);
  assert.strictEqual(appr.n, 2, 'one Supabase + one Sheet row counted; empty col-33 row excluded');
  assert.strictEqual(appr.beatPct, 100, 'both beat the close');
});
