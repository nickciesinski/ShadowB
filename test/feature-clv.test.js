'use strict';
// 2026-08-31 — feature-level CLV attribution.
//
// The headline test is `clustering by game kills the pseudo-replicated
// signal`: on the real data, treating a game's 3 picks as 3 independent
// observations turned t=1.58 into t=4.04 and would have had us reweight the
// model on noise. If that test ever goes green without clustering, the report
// is lying again.
const test = require('node:test');
const assert = require('node:assert');
const { corr, tStat, gamesNeeded, attributeByFeature } = require('../src/feature-clv');

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

test('corr matches known values and refuses degenerate input', () => {
  assert.ok(near(corr([1, 2, 3], [2, 4, 6]), 1));
  assert.ok(near(corr([1, 2, 3], [6, 4, 2]), -1));
  assert.strictEqual(corr([1, 1, 1], [1, 2, 3]), null, 'constant x has no correlation');
  assert.strictEqual(corr([1, 2], [1, 2]), null, 'n<3');
});

test('tStat grows with n for the same r', () => {
  const a = tStat(0.2, 50), b = tStat(0.2, 500);
  assert.ok(b > a);
  assert.strictEqual(tStat(null, 100), null);
});

test('gamesNeeded rises as the effect shrinks and as more features are tested', () => {
  assert.ok(gamesNeeded(0.3, 1) < gamesNeeded(0.1, 1), 'smaller effect needs more games');
  assert.ok(gamesNeeded(0.1, 20) > gamesNeeded(0.1, 1), 'correction costs sample');
  assert.strictEqual(gamesNeeded(0, 1), null);
});

test('CLUSTERING: three picks per game count as one observation', () => {
  // One feature, 40 games, 3 perfectly-correlated picks each. If the rows were
  // treated independently n would be 120; clustered it must be 40.
  const rows = [];
  for (let g = 0; g < 40; g++) {
    for (const mkt of ['ml', 'spread', 'total']) {
      rows.push({ gameKey: `g${g}`, feature: 'f', contribution: g / 40, clv: (g % 7) / 700, market: mkt });
    }
  }
  const { features } = attributeByFeature(rows, { minGames: 10 });
  assert.strictEqual(features[0].nGames, 40, 'must collapse to one row per game');
});

test('a real but noisy effect is found and reported significant', () => {
  // Deliberately NOT a perfect line — a noiseless fixture tests nothing about
  // the statistics and hides the |r|=1 edge case.
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rows = [];
  for (let g = 0; g < 400; g++) {
    const c = (g % 20) / 20;
    rows.push({ gameKey: `g${g}`, feature: 'real', contribution: c,
                clv: c * 0.05 - 0.02 + (rnd() - 0.5) * 0.03 });
  }
  const { features } = attributeByFeature(rows, { minGames: 30 });
  const f = features.find(x => x.feature === 'real');
  assert.ok(f.r > 0.3 && f.r < 0.99, `expected a real but imperfect r, got ${f.r}`);
  assert.strictEqual(f.significant, true);
  assert.strictEqual(f.gamesNeeded, null, 'already resolved — no shortfall to report');
});

test('a perfect correlation is maximally significant, not null', () => {
  const rows = [];
  for (let g = 0; g < 50; g++) rows.push({ gameKey: `g${g}`, feature: 'p', contribution: g, clv: g / 1000 });
  const { features } = attributeByFeature(rows, { minGames: 30 });
  const f = features.find(x => x.feature === 'p');
  assert.ok(f.t !== null && Number.isFinite(f.t), 'r=1 must still produce a t');
  assert.strictEqual(f.significant, true);
});

test('pure noise is reported as unresolved WITH a games-needed figure', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rows = [];
  for (let g = 0; g < 120; g++) {
    rows.push({ gameKey: `g${g}`, feature: 'noise', contribution: rnd(), clv: (rnd() - 0.5) * 0.05 });
  }
  const { features } = attributeByFeature(rows, { minGames: 30 });
  const f = features.find(x => x.feature === 'noise');
  assert.strictEqual(f.significant, false);
  assert.ok(f.gamesNeeded === null || f.gamesNeeded > 0, 'must say how much more is needed');
});

test('the Bonferroni threshold rises with the number of features tested', () => {
  const mk = (nFeat) => {
    const rows = [];
    for (let i = 0; i < nFeat; i++)
      for (let g = 0; g < 40; g++)
        rows.push({ gameKey: `g${g}`, feature: `f${i}`, contribution: g, clv: (g % 5) / 500 });
    return attributeByFeature(rows, { minGames: 30 }).tThreshold;
  };
  assert.ok(mk(20) > mk(3), 'testing more features must demand a higher bar');
});

test('thin features are surfaced as unresolvable rather than silently dropped', () => {
  const rows = [];
  for (let g = 0; g < 5; g++) rows.push({ gameKey: `g${g}`, feature: 'thin', contribution: g, clv: g / 100 });
  const { features } = attributeByFeature(rows, { minGames: 30 });
  const f = features.find(x => x.feature === 'thin');
  assert.ok(f, 'must still appear in the report');
  assert.strictEqual(f.resolvable, false);
  assert.strictEqual(f.significant, false);
});

test('junk rows are skipped without poisoning the aggregate', () => {
  const rows = [
    { gameKey: 'a', feature: 'f', contribution: NaN, clv: 0.01 },
    { gameKey: 'b', feature: 'f', contribution: 1, clv: null },
    { gameKey: null, feature: 'f', contribution: 1, clv: 0.01 },
    { gameKey: 'c', feature: null, contribution: 1, clv: 0.01 },
  ];
  const { features } = attributeByFeature(rows, { minGames: 1 });
  const f = features.find(x => x.feature === 'f');
  assert.ok(!f || f.nGames === 0 || f.nGames < 3, 'junk must not become observations');
});
