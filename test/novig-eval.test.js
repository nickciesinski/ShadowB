'use strict';
// Tests for src/novig-eval.js — the scorer for the pre-registered Novig
// maker-fill test (config/novig-fill-test.json, fixed 2026-09-12).
//
// The tests that matter most here are the ones pinning what the module must
// REFUSE to do: pool the pilot, count open orders as misses, treat tickets as
// independent, credit the price improvement into the primary figure, or say
// CONFIRMED on sample size. Each of those has a dedicated test, because each
// is a mistake this project has already made once somewhere else.

const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/novig-eval');

/** Build a normalized order row with sane defaults. */
function order(o = {}) {
  return {
    pickId: o.pickId || `p${Math.random().toString(36).slice(2, 8)}`,
    gameKey: o.gameKey === undefined ? `g${Math.random().toString(36).slice(2, 8)}` : o.gameKey,
    market: o.market || 'moneyline',
    orderedDate: o.orderedDate || '2026-09-15',
    state: o.state || 'filled',
    clvPp: o.clvPp === undefined ? 1.0 : o.clvPp,
    vigPp: o.vigPp === undefined ? 0 : o.vigPp,
    priceGainPp: o.priceGainPp,
  };
}

/** n independent filled orders, each its own game, with a given clv. */
function fills(n, clvPp, extra = {}) {
  return Array.from({ length: n }, (_, i) =>
    order({ ...extra, gameKey: `g${i}`, state: 'filled', clvPp: clvPp(i) }));
}

// ── isNum: the Number(null) === 0 trap ──────────────────────────────────────

test('isNum rejects null, empty string, undefined and booleans', () => {
  for (const v of [null, undefined, '', true, false, 'abc', NaN, Infinity]) {
    assert.strictEqual(E.isNum(v), false, `${String(v)} should not be numeric`);
  }
  for (const v of [0, -1.5, '2.5', 3]) {
    assert.strictEqual(E.isNum(v), true, `${String(v)} should be numeric`);
  }
});

test('a missing net edge is not scored as break-even', () => {
  // One real row at +2pp and one row with a null clv. If the null were coerced
  // to 0 the mean would be +1pp; it must be +2pp on n=1.
  const rows = [order({ gameKey: 'a', clvPp: 2 }), order({ gameKey: 'b', clvPp: null })];
  const s = E.summarizeBucket(rows, E.netEdgeAtLoggedPrice);
  assert.strictEqual(s.games, 1);
  assert.strictEqual(s.meanPp, 2);
});

test('a row missing its vig is excluded, not treated as zero vig', () => {
  assert.strictEqual(E.netEdgeAtLoggedPrice({ clvPp: 1, vigPp: null }), null);
  assert.strictEqual(E.netEdgeAtLoggedPrice({ clvPp: 1, vigPp: 0 }), 1);
});

// ── meanSd / tOfMean / rowsNeeded ───────────────────────────────────────────

test('meanSd returns nulls rather than NaN on an empty bucket', () => {
  assert.deepStrictEqual(E.meanSd([]), { n: 0, mean: null, sd: null });
  const one = E.meanSd([5]);
  assert.strictEqual(one.n, 1);
  assert.strictEqual(one.mean, 5);
  assert.strictEqual(one.sd, null);
});

test('meanSd uses the sample sd (n-1)', () => {
  const { sd } = E.meanSd([1, 2, 3]);
  assert.ok(Math.abs(sd - 1) < 1e-12);
});

test('tOfMean against zero, and against a non-zero baseline', () => {
  const xs = [1, 1, 1, 1.0001];
  assert.ok(E.tOfMean(xs) > 0);
  // Against a baseline above the mean, the t must go negative — this is the
  // form pre-registered kill condition 2 is checked in.
  assert.ok(E.tOfMean(xs, 5) < 0);
});

test('tOfMean is null when it cannot be computed, never a guessed zero', () => {
  assert.strictEqual(E.tOfMean([]), null);
  assert.strictEqual(E.tOfMean([3]), null);
  assert.strictEqual(E.tOfMean([2, 2, 2]), null); // sd === 0, t undefined
});

test('rowsNeeded scales with the square of sd/mean', () => {
  assert.strictEqual(E.rowsNeeded(1, 1, 2), 4);
  assert.strictEqual(E.rowsNeeded(0.5, 1, 2), 16);
  assert.strictEqual(E.rowsNeeded(0, 1, 2), null);
  assert.strictEqual(E.rowsNeeded(1, 0, 2), null);
});

// ── clustering: the pseudo-replication guard ────────────────────────────────

test('clusterByGame collapses a game to one observation', () => {
  const rows = [
    order({ gameKey: 'g1', market: 'moneyline', clvPp: 3 }),
    order({ gameKey: 'g1', market: 'spread', clvPp: 1 }),
    order({ gameKey: 'g1', market: 'total', clvPp: 2 }),
  ];
  const c = E.clusterByGame(rows, (r) => r.clvPp);
  assert.deepStrictEqual(c, [2]); // one game, mean of its three tickets
});

test('clustering shrinks t — the 2026-08-31 lesson, pinned', () => {
  // 20 games x 3 correlated tickets. Unclustered this is 60 observations.
  const rows = [];
  for (let g = 0; g < 20; g++) {
    for (const m of ['moneyline', 'spread', 'total']) {
      rows.push(order({ gameKey: `g${g}`, market: m, clvPp: 0.4 + (g % 5) * 0.1 }));
    }
  }
  const clustered = E.clusterByGame(rows, (r) => r.clvPp);
  const unclustered = rows.map((r) => r.clvPp);
  assert.strictEqual(clustered.length, 20);
  assert.strictEqual(unclustered.length, 60);
  assert.ok(Math.abs(E.tOfMean(clustered)) < Math.abs(E.tOfMean(unclustered)),
    'clustered t must be smaller than the unclustered t');
});

test('rows with no game key each become their own cluster, not one fake game', () => {
  const rows = [
    order({ gameKey: null, clvPp: 1 }),
    order({ gameKey: '', clvPp: 3 }),
  ];
  const c = E.clusterByGame(rows, (r) => r.clvPp);
  assert.strictEqual(c.length, 2);
});

// ── refusal 3: an open order is not a miss ──────────────────────────────────

test('open orders are excluded from the fill rate, not counted as misses', () => {
  const rows = [
    order({ state: 'filled' }), order({ state: 'filled' }),
    order({ state: 'unfilled' }), order({ state: 'unfilled' }),
    order({ state: 'ordered' }), order({ state: 'ordered' }), order({ state: 'ordered' }),
  ];
  const r = E.evaluateFillTest(rows);
  assert.strictEqual(r.forward.posted, 7);
  assert.strictEqual(r.forward.decided, 4);
  assert.strictEqual(r.forward.open, 3);
  assert.strictEqual(r.forward.fillRate, 0.5); // 2/4, not 2/7
});

test('fill rate is null rather than zero when nothing has resolved', () => {
  const r = E.evaluateFillTest([order({ state: 'ordered' })]);
  assert.strictEqual(r.forward.fillRate, null);
  assert.strictEqual(r.verdict, 'no forward fills yet');
});

test('an unrecognised state is counted unusable, never assigned to a bucket', () => {
  // Built literally rather than via order(), so the empty string survives the
  // helper's default instead of becoming 'filled'.
  const base = order({ state: 'filled' });
  const r = E.evaluateFillTest([
    { ...base, gameKey: 'a', state: 'cancelled' },
    { ...base, gameKey: 'b', state: '' },
    { ...base, gameKey: 'c', state: 'filled' },
  ]);
  assert.strictEqual(r.unusable, 2);
  assert.strictEqual(r.forward.filled, 1);
});

test('an unparseable date is unusable rather than silently dated today', () => {
  const r = E.evaluateFillTest([order({ orderedDate: 'not-a-date' })]);
  assert.strictEqual(r.unusable, 1);
  assert.strictEqual(r.forward.posted, 0);
});

// ── refusal 1: the pilot is never pooled ────────────────────────────────────

test('pilot orders are bucketed separately and excluded from the forward test', () => {
  const rows = [
    ...fills(3, () => 5, { orderedDate: '2026-09-11' }),       // pilot, huge CLV
    ...fills(2, () => 0.1, { orderedDate: '2026-09-20' }),     // forward
  ];
  const r = E.evaluateFillTest(rows);
  assert.strictEqual(r.pilot.filled, 3);
  assert.strictEqual(r.forward.filled, 2);
  // The forward mean must not be dragged up by the pilot's 5pp rows.
  assert.ok(r.forward.netEdge.meanPp < 1);
});

test('the measured-from boundary is inclusive of the pre-registration date', () => {
  const r = E.evaluateFillTest([
    order({ orderedDate: '2026-09-11' }),
    order({ orderedDate: '2026-09-12' }),
  ]);
  assert.strictEqual(r.pilot.filled, 1);
  assert.strictEqual(r.forward.filled, 1);
});

// ── refusal 4: the price improvement is never primary ───────────────────────

test('the primary net edge ignores the price gain; the optimistic read includes it', () => {
  const rows = fills(3, () => 0.5, { priceGainPp: 2.0, vigPp: 0 });
  const r = E.evaluateFillTest(rows);
  assert.ok(Math.abs(r.forward.netEdge.meanPp - 0.5) < 1e-12);
  assert.ok(Math.abs(r.forward.netEdgeAtFillPrice.meanPp - 2.5) < 1e-12);
});

test('a row without a price gain drops out of the optimistic figure only', () => {
  const rows = [
    order({ gameKey: 'a', clvPp: 1, priceGainPp: 2 }),
    order({ gameKey: 'b', clvPp: 1 }), // no priceGainPp
  ];
  const r = E.evaluateFillTest(rows);
  assert.strictEqual(r.forward.netEdge.games, 2);
  assert.strictEqual(r.forward.netEdgeAtFillPrice.games, 1);
});

test('the verdict is computed from the pessimistic basis', () => {
  // Negative at the logged price, strongly positive once the price gain is
  // credited. The verdict must follow the logged price and kill it.
  const rows = fills(45, (i) => -0.5 + (i % 3) * 0.01, { priceGainPp: 3, vigPp: 0 });
  const r = E.evaluateFillTest(rows);
  assert.ok(r.forward.netEdgeAtFillPrice.meanPp > 2);
  assert.match(r.verdict, /^KILLED/);
});

// ── refusal 5: never CONFIRMED on sample size ───────────────────────────────

test('below the pre-registered 40 fills the verdict is INSUFFICIENT, however good', () => {
  const rows = fills(10, (i) => 4 + (i % 2) * 0.01); // enormous, tight, t huge
  const r = E.evaluateFillTest(rows);
  assert.match(r.verdict, /^INSUFFICIENT/);
  assert.match(r.verdict, /10 of 40 fills/);
  assert.ok(r.forward.netEdge.t > 10, 'sanity: this sample would otherwise scream significance');
});

test('CONFIRMED requires both a positive mean and |t| >= the bar', () => {
  const good = E.evaluateFillTest(fills(45, (i) => 1 + (i % 3) * 0.05));
  assert.match(good.verdict, /^CONFIRMED/);
});

test('a positive but noisy mean at full sample is INCONCLUSIVE, not CONFIRMED', () => {
  // Alternating large +/- values: mean slightly positive, t far below 2.
  const rows = fills(45, (i) => (i % 2 === 0 ? 20 : -19.9));
  const r = E.evaluateFillTest(rows);
  assert.ok(r.forward.netEdge.meanPp > 0);
  assert.ok(Math.abs(r.forward.netEdge.t) < 2);
  assert.match(r.verdict, /^INCONCLUSIVE/);
});

test('a non-positive mean at full sample fires kill condition 1', () => {
  const r = E.evaluateFillTest(fills(45, (i) => -0.3 + (i % 4) * 0.02));
  assert.match(r.verdict, /^KILLED/);
  const k = r.killChecks.find((c) => c.id === 'net_edge_nonpositive');
  assert.strictEqual(k.status, 'FIRED');
});

test('kill conditions report not_yet_checkable rather than passed when unmeasured', () => {
  const r = E.evaluateFillTest(fills(5, () => 1));
  const k = r.killChecks.find((c) => c.id === 'net_edge_nonpositive');
  assert.strictEqual(k.status, 'not_yet_checkable');
});

// ── adverse selection ───────────────────────────────────────────────────────

test('capture ratio reproduces the 2026-09-11 pilot arithmetic', () => {
  // Four fills averaging 0.72pp, four misses averaging 2.54pp → 0.283.
  const rows = [
    ...fills(4, () => 0.72, { orderedDate: '2026-09-20', state: 'filled' }),
    ...Array.from({ length: 4 }, (_, i) =>
      order({ gameKey: `m${i}`, state: 'unfilled', clvPp: 2.54, orderedDate: '2026-09-20' })),
  ];
  const r = E.evaluateFillTest(rows);
  assert.ok(Math.abs(r.forward.captureRatio - (0.72 / 2.54)) < 1e-9);
});

test('capture ratio is null when the missed bucket has no usable CLV', () => {
  const r = E.evaluateFillTest(fills(3, () => 1));
  assert.strictEqual(r.forward.captureRatio, null);
});

test('selection is a Welch comparison of filled vs missed CLV, clustered', () => {
  const rows = [
    ...fills(20, (i) => 0.5 + (i % 3) * 0.1, { orderedDate: '2026-09-20' }),
    ...Array.from({ length: 20 }, (_, i) =>
      order({ gameKey: `m${i}`, state: 'unfilled', clvPp: 3 + (i % 3) * 0.1, orderedDate: '2026-09-20' })),
  ];
  const r = E.evaluateFillTest(rows);
  assert.ok(r.forward.selection.diff < 0, 'fills carried less CLV than misses');
  assert.ok(r.forward.selection.t < -2);
});

test('welchT is null rather than a number when a side is too small', () => {
  assert.strictEqual(E.welchT([1], [1, 2, 3]), null);
  assert.strictEqual(E.welchT([], []), null);
});

// ── kill condition 2: CLV collapse vs the rule-C baseline ───────────────────

test('CLV sitting at the rule-C baseline does not fire the collapse check', () => {
  const r = E.evaluateFillTest(fills(45, (i) => 0.72 + (i % 3 - 1) * 0.05));
  const k = r.killChecks.find((c) => c.id === 'clv_collapse_below_rule_c');
  assert.strictEqual(k.status, 'passed');
});

test('CLV significantly below the baseline fires the collapse check', () => {
  const r = E.evaluateFillTest(fills(45, (i) => -1.5 + (i % 3 - 1) * 0.05));
  const k = r.killChecks.find((c) => c.id === 'clv_collapse_below_rule_c');
  assert.strictEqual(k.status, 'FIRED');
});

test('the baseline is configurable and actually used', () => {
  const rows = fills(45, (i) => 0.72 + (i % 3 - 1) * 0.05);
  const strict = E.evaluateFillTest(rows, { baselineClvPp: 5 });
  assert.strictEqual(
    strict.killChecks.find((c) => c.id === 'clv_collapse_below_rule_c').status, 'FIRED');
});

// ── kill condition 3: market concentration ──────────────────────────────────

test('market mix reports shares and the largest one', () => {
  const mix = E.marketMix([
    { market: 'spread' }, { market: 'spread' }, { market: 'spread' }, { market: 'total' },
  ]);
  assert.strictEqual(mix.total, 4);
  assert.strictEqual(mix.topMarket, 'spread');
  assert.ok(Math.abs(mix.topShare - 0.75) < 1e-12);
});

test('a missing market is labelled unknown rather than dropped', () => {
  const mix = E.marketMix([{ market: null }, { market: 'total' }]);
  assert.strictEqual(mix.counts.unknown, 1);
  assert.strictEqual(mix.total, 2);
});

test('concentration is FLAGGED, not FIRED — it is a caveat, not a kill', () => {
  const rows = fills(10, () => 1, { market: 'spread' });
  const r = E.evaluateFillTest(rows);
  const k = r.killChecks.find((c) => c.id === 'market_concentration');
  assert.strictEqual(k.status, 'FLAGGED');
  // and it did not turn the overall verdict into a kill
  assert.match(r.verdict, /^INSUFFICIENT/);
});

test('an even market spread passes the concentration check', () => {
  const rows = [
    ...fills(5, () => 1, { market: 'moneyline' }),
    ...Array.from({ length: 5 }, (_, i) => order({ gameKey: `s${i}`, market: 'spread' })),
    ...Array.from({ length: 5 }, (_, i) => order({ gameKey: `t${i}`, market: 'total' })),
  ];
  const r = E.evaluateFillTest(rows);
  assert.strictEqual(
    r.killChecks.find((c) => c.id === 'market_concentration').status, 'passed');
});

// ── shape / robustness ──────────────────────────────────────────────────────

test('empty and malformed input produce a report, not a throw', () => {
  for (const input of [[], null, undefined, [null, undefined, 0, 'x']]) {
    const r = E.evaluateFillTest(input);
    assert.strictEqual(r.forward.filled, 0);
    assert.strictEqual(r.verdict, 'no forward fills yet');
  }
});

test('gamesNeeded says how far short the sample is', () => {
  // Small mean, large spread: answerable only far beyond the sample in hand.
  const r = E.evaluateFillTest(fills(6, (i) => 0.2 + (i % 3 - 1) * 2));
  assert.ok(r.forward.netEdge.gamesNeeded > 100);
  assert.strictEqual(r.forward.netEdge.resolvable, false);
});

test('the pilot bucket carries its own not-evidence warning', () => {
  const r = E.evaluateFillTest([order({ orderedDate: '2026-09-11' })]);
  assert.match(r.pilot._warning, /NOT EVIDENCE/);
});

test('minFills and tBar are configurable and echoed back', () => {
  const r = E.evaluateFillTest(fills(12, (i) => 1 + (i % 3) * 0.05), { minFills: 10, tBar: 3 });
  assert.strictEqual(r.minFills, 10);
  assert.strictEqual(r.tBar, 3);
  assert.match(r.verdict, /^CONFIRMED/);
});

// ── scripts/novig-fill-report.js: the join and the unit conversion ──────────
//
// The arithmetic is in the module above; the ×100 is in the script. A
// factor-of-100 slip there would read as a spectacular edge rather than an
// error, so it is pinned here.

const { normalize, render } = require('../scripts/novig-fill-report');

test('normalize converts clv_prob_delta from a fraction to probability points', () => {
  const orders = [{ pick_id: 'p1', game_date: '2026-09-15', posted_cents: 41, state: 'filled' }];
  const ledger = new Map([['p1', {
    pick_id: 'p1', game: 'AAA@BBB', market: 'moneyline', league: 'MLB',
    odds: 140, clv_prob_delta: 0.0072,
  }]]);
  const { rows } = normalize(orders, ledger);
  assert.strictEqual(rows.length, 1);
  assert.ok(Math.abs(rows[0].clvPp - 0.72) < 1e-9, 'a 0.0072 fraction is 0.72pp');
});

test('normalize prices the Novig MAKER fee from config, not as a hardcoded zero', () => {
  const orders = [{ pick_id: 'p1', game_date: '2026-09-15', posted_cents: 50, state: 'filled' }];
  const ledger = new Map([['p1', { pick_id: 'p1', game: 'g', market: 'total', odds: 100, clv_prob_delta: 0 }]]);
  const { rows } = normalize(orders, ledger);
  // config/venues.json gives the maker a coefficient of 0 today. The point of
  // the test is that the number came from venueCost(), so a change to the fee
  // schedule surfaces here instead of being assumed away.
  assert.strictEqual(rows[0].vigPp, 0);
});

test('normalize computes the price improvement as book implied minus posted', () => {
  // +140 implies 1/2.4 = 41.67%. Posting at 41c is 0.67pp better.
  const orders = [{ pick_id: 'p1', game_date: '2026-09-15', posted_cents: 41, state: 'filled' }];
  const ledger = new Map([['p1', { pick_id: 'p1', game: 'g', market: 'moneyline', odds: 140, clv_prob_delta: 0 }]]);
  const { rows } = normalize(orders, ledger);
  assert.ok(rows[0].priceGainPp > 0.6 && rows[0].priceGainPp < 0.7);
});

test('normalize prefers the actual fill price over the posted price', () => {
  const orders = [{ pick_id: 'p1', game_date: '2026-09-15', posted_cents: 41, fill_cents: 39, state: 'filled' }];
  const ledger = new Map([['p1', { pick_id: 'p1', game: 'g', market: 'moneyline', odds: 140, clv_prob_delta: 0 }]]);
  const { rows } = normalize(orders, ledger);
  assert.ok(rows[0].priceGainPp > 2.6 && rows[0].priceGainPp < 2.7, 'filled 2c better than posted');
});

test('normalize leaves the price gain undefined on an invalid book price', () => {
  // odds = -1 is the poisoned value that broke CLV in August; it must not
  // become a price improvement of 99pp.
  const orders = [{ pick_id: 'p1', game_date: '2026-09-15', posted_cents: 41, state: 'filled' }];
  const ledger = new Map([['p1', { pick_id: 'p1', game: 'g', market: 'moneyline', odds: -1, clv_prob_delta: 0 }]]);
  const { rows } = normalize(orders, ledger);
  assert.strictEqual(rows[0].priceGainPp, undefined);
});

test('normalize counts orders with no ledger row instead of dropping them silently', () => {
  const orders = [
    { pick_id: 'p1', game_date: '2026-09-15', posted_cents: 41, state: 'filled' },
    { pick_id: 'ghost', game_date: '2026-09-15', posted_cents: 41, state: 'filled' },
  ];
  const ledger = new Map([['p1', { pick_id: 'p1', game: 'g', market: 'total', odds: 100, clv_prob_delta: 0.001 }]]);
  const { rows, unjoined } = normalize(orders, ledger);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(unjoined, 1);
});

test('normalize keeps a null clv as null rather than zero', () => {
  const orders = [{ pick_id: 'p1', game_date: '2026-09-15', posted_cents: 41, state: 'filled' }];
  const ledger = new Map([['p1', { pick_id: 'p1', game: 'g', market: 'total', odds: 100, clv_prob_delta: null }]]);
  const { rows } = normalize(orders, ledger);
  assert.strictEqual(rows[0].clvPp, null);
  // and it must not reach the mean
  const r = E.evaluateFillTest(rows);
  assert.strictEqual(r.forward.netEdge.games, 0);
});

test('render produces a report on an empty forward sample without throwing', () => {
  const r = E.evaluateFillTest([]);
  const md = render(r, { preRegDate: '2026-09-12', orderRows: 0, ledgerRows: 0, unjoined: 0 });
  assert.match(md, /Novig Maker-Fill Test/);
  assert.match(md, /no forward fills yet/);
  assert.match(md, /NOT evidence/);
});

test('render states the verdict and never buries the sample shortfall', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    pickId: `p${i}`, gameKey: `g${i}`, market: 'moneyline', orderedDate: '2026-09-15',
    state: 'filled', clvPp: 1, vigPp: 0,
  }));
  const md = render(E.evaluateFillTest(rows),
    { preRegDate: '2026-09-12', orderRows: 7, ledgerRows: 7, unjoined: 0 });
  assert.match(md, /INSUFFICIENT: 7 of 40 fills/);
});
