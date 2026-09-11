'use strict';
// 2026-09-10 — candidate features: measurable without being staked.
//
// Until today decomposeScore dropped every feature with weight 0, which meant a
// new idea could not be evaluated without first giving it a weight — you had to
// change picks to find out whether changing picks was a good idea. Four features
// added at starter weight 0.0 on 2026-05-02 (mlb_run_diff, nba_pace_adj_net,
// nfl_points_margin, nhl_goal_diff) were invisible for four months as a result.
//
// The headline test is `a candidate carries its raw value, not value * 0`. A
// column of zeros is constant, and a constant correlates with nothing, so
// logging value*0 would report every candidate as permanently unmeasurable —
// the same silence in a new costume.
const test = require('node:test');
const assert = require('node:assert');
const { decomposeScore } = require('../src/game-features');

const feats = { live: 2, cand: 5, negCand: -3, absent: null };
const weights = { live: 1.5, cand: 0, negCand: 0, absent: 0 };

test('default behaviour is unchanged — candidates are opt-in', () => {
  // Every existing caller passes two arguments and must see exactly what it
  // saw before; a candidate leaking into the live set would be staked on.
  const out = decomposeScore(feats, weights);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].feature, 'live');
  assert.ok(out.every(c => !c.candidate));
});

test('a candidate carries its raw value, not value * 0', () => {
  const out = decomposeScore(feats, weights, { includeCandidates: true });
  const c = out.find(x => x.feature === 'cand');
  assert.strictEqual(c.contribution, 5, 'must be the value, not 0');
  assert.strictEqual(c.weight, 0, 'weight stays 0 so nothing treats it as live');
  assert.strictEqual(c.candidate, true);
});

test('candidates preserve sign', () => {
  const out = decomposeScore(feats, weights, { includeCandidates: true });
  assert.strictEqual(out.find(x => x.feature === 'negCand').contribution, -3);
});

test('a candidate with no value is not logged', () => {
  const out = decomposeScore(feats, weights, { includeCandidates: true });
  assert.ok(!out.some(x => x.feature === 'absent'), 'a null value is not an observation');
});

test('live features sort first, so the edge driver is never a candidate', () => {
  // A candidate moved nothing. Reporting one as the driver of a pick would
  // attribute the pick to a feature with no part in it.
  const out = decomposeScore({ live: 1, cand: 999 }, { live: 0.5, cand: 0 },
    { includeCandidates: true });
  assert.strictEqual(out[0].feature, 'live', 'a huge candidate must not outrank a live feature');
  assert.strictEqual(out[0].candidate, undefined);
});

test('live contributions still sort by magnitude', () => {
  const out = decomposeScore({ a: 1, b: 10 }, { a: 1, b: 1 }, { includeCandidates: true });
  assert.deepStrictEqual(out.map(c => c.feature), ['b', 'a']);
});

test('mlb_run_diff is a real zero-weight candidate in the shipped config', () => {
  // The concrete case this was built for. If it ever gains a weight this test
  // should be updated deliberately, not silently.
  const cfg = require('../config/model-params.MLB.json');
  const weighted = Object.values(cfg)
    .filter(v => v && typeof v === 'object')
    .some(w => Number(w.mlb_run_diff) !== 0 && w.mlb_run_diff !== undefined);
  assert.strictEqual(weighted, false, 'mlb_run_diff is still weighted 0 everywhere');
});
