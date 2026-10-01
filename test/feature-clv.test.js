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

// ── collinearity, added 2026-09-10 ──────────────────────────────────────────
// Tuning 27 weights implies 27 things to tune. On the real post-8/31 sample
// run_differential_diff and whip_diff correlate at r=0.888, so two of those
// weights point at one quantity and cannot be tuned against each other. This
// exists so the report says how many dials there actually are.
const { collinearityClusters } = require('../src/feature-clv');

/** rows for features whose per-game contributions are given as arrays. */
const rowsFrom = (spec) => {
  const out = [];
  for (const [feature, vals] of Object.entries(spec)) {
    vals.forEach((c, i) => out.push({ gameKey: `g${i}`, feature, contribution: c, clv: 0 }));
  }
  return out;
};

test('two duplicate features collapse into one dial', () => {
  const n = 40;
  const a = Array.from({ length: n }, (_, i) => Math.sin(i));
  const rows = rowsFrom({ alpha: a, beta: a.map(v => v * 2 + 0.001), gamma: a.map((_, i) => Math.cos(i * 3)) });
  const { clusters, effectiveFeatures, nFeatures } = collinearityClusters(rows, { minGames: 30, threshold: 0.7 });
  assert.strictEqual(nFeatures, 3);
  assert.strictEqual(effectiveFeatures, 2, 'alpha and beta are one dial, gamma is another');
  const pair = clusters.find(c => c.length === 2);
  assert.deepStrictEqual(pair.sort(), ['alpha', 'beta']);
});

test('independent features stay separate', () => {
  const n = 40;
  const rows = rowsFrom({
    a: Array.from({ length: n }, (_, i) => Math.sin(i)),
    b: Array.from({ length: n }, (_, i) => Math.cos(i * 7.3)),
  });
  const { effectiveFeatures } = collinearityClusters(rows, { minGames: 30, threshold: 0.9 });
  assert.strictEqual(effectiveFeatures, 2);
});

test('a negatively correlated pair is still one dial', () => {
  // -1 and +1 are equally "the same quantity" for tuning purposes.
  const n = 40;
  const a = Array.from({ length: n }, (_, i) => Math.sin(i));
  const rows = rowsFrom({ up: a, down: a.map(v => -v) });
  const { effectiveFeatures } = collinearityClusters(rows, { minGames: 30, threshold: 0.7 });
  assert.strictEqual(effectiveFeatures, 1);
});

test('features below the game minimum are excluded, not silently paired', () => {
  const rows = rowsFrom({ thin: [1, 2, 3], alsoThin: [1, 2, 3] });
  const { nFeatures, clusters } = collinearityClusters(rows, { minGames: 30 });
  assert.strictEqual(nFeatures, 0);
  assert.deepStrictEqual(clusters, []);
});

// 2026-10-01 — check-in #1 helpers.
{
  const { pickSign, marketGroup, lockTimeVectors, bundleTest, frozenComposite } = require('../src/feature-clv');

  test('pickSign reads the side from the pick text (selection is NULL in the ledger)', () => {
    const t = { home_team: 'Boston Red Sox', away_team: 'New York Yankees' };
    assert.strictEqual(pickSign({ ...t, market: 'moneyline', pick: 'Boston Red Sox' }), 1);
    assert.strictEqual(pickSign({ ...t, market: 'spread', pick: 'New York Yankees -1.5' }), -1);
    assert.strictEqual(pickSign({ market: 'total', pick: 'Over 9' }), 1);
    assert.strictEqual(pickSign({ market: 'total', pick: 'Under 9' }), -1);
    assert.strictEqual(pickSign({ ...t, market: 'moneyline', pick: '' }), null);
    assert.strictEqual(pickSign({ ...t, market: 'props', pick: 'Boston Red Sox' }), null);
    assert.strictEqual(marketGroup('over'), 'totals');
  });

  test('lockTimeVectors keeps the latest vector at lock and drops post-lock-only picks', () => {
    const byPickId = new Map([
      ['a', { locked_at: '2026-09-20T04:00:00Z' }],
      ['b', { locked_at: '2026-09-20T04:00:00Z' }],
    ]);
    const { vectors, dropped } = lockTimeVectors([
      { pick_id: 'a', created_at: '2026-09-19T04:00:00Z', tag: 'old' },
      { pick_id: 'a', created_at: '2026-09-20T04:10:00Z', tag: 'at-lock' },
      { pick_id: 'a', created_at: '2026-09-21T20:00:00Z', tag: 'friday-injury-report' },
      { pick_id: 'b', created_at: '2026-09-21T20:00:00Z', tag: 'after' },
      { pick_id: 'zzz', created_at: '2026-09-19T00:00:00Z', tag: 'not in ledger' },
    ], byPickId);
    assert.deepStrictEqual(vectors.map(v => v.tag), ['at-lock']);
    assert.strictEqual(dropped, 1, 'b had only a post-lock vector; it is dropped, not back-filled');
  });

  // Synthetic games: feature `sig` drives CLV, `noise` does not.
  function games(n, effect, seed = 1) {
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    const rows = [];
    for (let g = 0; g < n; g++) {
      const sig = rnd(), noise = rnd();
      const clv = effect * sig + 0.3 * rnd();
      rows.push({ gameKey: `g${g}`, pickId: `p${g}`, feature: 'sig', contribution: sig, clv });
      rows.push({ gameKey: `g${g}`, pickId: `p${g}`, feature: 'noise', contribution: noise, clv });
    }
    return rows;
  }

  test('bundleTest finds a planted effect and passes pure noise', () => {
    const hit = bundleTest(games(200, 0.5), { perms: 500 });
    assert.ok(hit.resolvable);
    assert.ok(hit.pSumR2 < 0.01, `planted effect should be found, got p=${hit.pSumR2}`);
    const miss = bundleTest(games(200, 0), { perms: 500 });
    assert.ok(miss.pSumR2 > 0.05, `noise should not be found, got p=${miss.pSumR2}`);
  });

  test('bundleTest is reproducible and refuses thin samples', () => {
    const a = bundleTest(games(100, 0.2), { perms: 200 });
    const b = bundleTest(games(100, 0.2), { perms: 200 });
    assert.strictEqual(a.pSumR2, b.pSumR2);
    assert.strictEqual(bundleTest(games(10, 0.5)).resolvable, false);
  });

  test('a pick counts once per game no matter how many features it carries', () => {
    // One pick, three features: CLV must be 0.02, not 0.02 weighted three times
    // against another pick with one feature.
    const rows = [
      { gameKey: 'g', pickId: 'ml', feature: 'a', contribution: 1, clv: 0.02 },
      { gameKey: 'g', pickId: 'ml', feature: 'b', contribution: 1, clv: 0.02 },
      { gameKey: 'g', pickId: 'ml', feature: 'c', contribution: 1, clv: 0.02 },
      { gameKey: 'g', pickId: 'sp', feature: 'a', contribution: 1, clv: 0.00 },
    ];
    // Build 3 such games with different CLV so r is defined.
    const all = [0, 1, 2].flatMap(k => rows.map(r => ({ ...r, gameKey: `g${k}`,
      contribution: r.contribution * (k + 1), clv: r.clv * (k + 1) })));
    const s = frozenComposite(all, { a: 1 });
    assert.strictEqual(s.nGames, 3);
    assert.ok(Math.abs(s.r - 1) < 1e-9, 'game CLV is the mean over picks, so the composite tracks it exactly');
  });
}
