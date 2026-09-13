'use strict';
// =============================================================
// src/novig-eval.js — score the pre-registered Novig maker-fill test
//
// 2026-09-13. `config/novig-fill-test.json` fixed the decision rule on
// 2026-09-12, `novig_orders` has been accumulating posted / filled / unfilled
// rows since, and `src/novig-settle.js` closes out the ones Nick never came
// back to. Nothing read any of it back. This module reads it back.
//
// That is the same gap `src/rule-c-eval.js` was written to close: a
// pre-registration is only worth something if something eventually scores it,
// and a stamp nobody reads is a test that was never run.
//
// It is READ-ONLY ARITHMETIC. It never decides a stake, never sizes one, and
// must never be imported by the pick, approval or grade path. Turning a
// confirmed result into a staking rule is a separate, deliberate commit made
// after this readout says so.
//
// ── FIVE THINGS IT REFUSES TO DO ────────────────────────────────────────────
//
//  1. Pool the 2026-09-11 pilot with the forward sample. Eight orders on one
//     day, on a day that ran +1.63pp CLV against rule C's historical +0.72pp.
//     The pre-registration records it explicitly as NOT evidence. It is
//     reported in its own bucket and never summed into the test.
//
//  2. Treat tickets as independent. A game's moneyline, spread and total share
//     one line move. Unclustered, that turned a feature t of 1.58 into 4.04 on
//     2026-08-31. Everything here CLUSTERS BY GAME first.
//
//  3. Count an open order as a miss. An order still at 'ordered' has not
//     resolved; it is neither a fill nor a no-fill. Putting it in the
//     denominator would understate the fill rate by however many orders happen
//     to be pending at read time — a number that depends on when you ran the
//     report. Open orders are reported separately and excluded from the rate.
//
//  4. Credit the 10-cent price improvement into the primary figure. The
//     pre-registered statistic is literally `clv_prob_delta - vig_at_novig`,
//     and `clv_prob_delta` is measured against the price on the ledger. Adding
//     the improvement on top risks double-counting it. The improvement IS
//     reported, as `atFillPrice`, clearly marked as the optimistic read.
//     Unmodelled upside is safe; unmodelled cost is not.
//
//  5. Say CONFIRMED on sample size. Below the pre-registered 40 fills the
//     verdict is INSUFFICIENT and nothing else, however good the mean looks.
//
// ── UNITS ───────────────────────────────────────────────────────────────────
// Everything in and out of this module is in probability POINTS (pp), i.e.
// percentage points: 0.72 means 0.72pp. `src/venue-cost.js` returns fractions,
// so the caller multiplies by 100 before handing rows over. Mixing the two
// scales by a factor of 100 is exactly the kind of error that would read as a
// spectacular edge, so the conversion lives in one place: the report script.
// =============================================================

// The day the decision rule was fixed. Orders before it are the pilot.
const MEASURED_FROM_ISO = '2026-09-12';

// Rule C's historical fill-free CLV, the yardstick the pre-registration names
// for "is the market selecting against us, or merely skimming the windfalls?"
const RULE_C_BASELINE_CLV_PP = 0.72;

/**
 * A value is only numeric if it really is one. `Number(null)` and `Number('')`
 * are both 0 and both finite, so a lazy filter scores a missing net edge as
 * exact break-even and pulls every mean toward zero. That bug shipped once in
 * the first draft of rule-c-eval and was caught only by its own test.
 */
function isNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return false;
  return Number.isFinite(Number(v));
}

/** Mean / sample sd of a numeric array. n=0 → nulls, never NaN. */
function meanSd(values) {
  const xs = (values || []).filter(isNum).map(Number);
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, sd: null };
  const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return { n, mean, sd: Math.sqrt(ss / (n - 1)) };
}

/**
 * One-sample t of a bucket against `mu`. Default mu=0 answers "is this
 * different from break-even?"; mu=0.72 answers "has fill-conditional CLV
 * collapsed below the rule-C baseline?", which is pre-registered kill
 * condition 2. Null when it cannot be computed, never a guessed 0.
 */
function tOfMean(values, mu = 0) {
  const { n, mean, sd } = meanSd(values);
  if (n < 2 || sd === null) return null;
  if (sd === 0) return null; // degenerate: no variation, t undefined
  return (mean - mu) / (sd / Math.sqrt(n));
}

/**
 * How many clustered observations a bucket needs before an effect of the size
 * currently observed would clear |t| = tTarget. The honest headline of a null
 * result: not "it failed" but "it is this far from answerable".
 */
function rowsNeeded(mean, sd, tTarget = 2) {
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || mean === 0 || sd === 0) return null;
  return Math.ceil(Math.pow((tTarget * sd) / mean, 2));
}

/**
 * Collapse tickets to one observation per game — the clustering step.
 *
 * Rows with no game key each become their own cluster: dropping them would
 * silently shrink the sample, and lumping them under one blank key would
 * fabricate a single enormous fake game.
 *
 * @param {Array} rows
 * @param {function} valueOf  row → number (or non-numeric to skip the row)
 */
function clusterByGame(rows, valueOf) {
  const pick = valueOf || ((r) => r.netEdgePp);
  const games = new Map();
  let anon = 0;
  for (const r of rows || []) {
    if (!r) continue;
    const v = pick(r);
    if (!isNum(v)) continue;
    const key = (r.gameKey == null || r.gameKey === '') ? `__anon_${anon++}` : String(r.gameKey);
    if (!games.has(key)) games.set(key, { sum: 0, n: 0 });
    const g = games.get(key);
    g.sum += Number(v); g.n += 1;
  }
  return [...games.values()].map((g) => g.sum / g.n);
}

/**
 * Net edge on the pre-registered basis: CLV minus what the venue charges.
 * Returns null unless BOTH inputs are genuinely numeric — a row missing its
 * vig is not a row with zero vig.
 */
function netEdgeAtLoggedPrice(row) {
  if (!row || !isNum(row.clvPp) || !isNum(row.vigPp)) return null;
  return Number(row.clvPp) - Number(row.vigPp);
}

/**
 * The optimistic read: the same figure plus the price improvement locked in at
 * fill time. Reported, never primary — see refusal 4 in the header.
 */
function netEdgeAtFillPrice(row) {
  const base = netEdgeAtLoggedPrice(row);
  if (base === null || !isNum(row.priceGainPp)) return null;
  return base + Number(row.priceGainPp);
}

/** Summarize one bucket on one metric: clustered mean, t, and what it needs. */
function summarizeBucket(rows, valueOf, opts = {}) {
  const minN = opts.minN == null ? 40 : opts.minN;
  const tBar = opts.tBar == null ? 2 : opts.tBar;
  const clustered = clusterByGame(rows, valueOf);
  const { n, mean, sd } = meanSd(clustered);
  const t = tOfMean(clustered);
  return {
    orders: (rows || []).length,
    games: n,
    meanPp: mean,
    sdPp: sd,
    t,
    resolvable: n >= minN && t !== null,
    gamesNeeded: rowsNeeded(mean, sd, tBar),
  };
}

/** Welch two-sample t between two buckets' clustered means. */
function welchT(aValues, bValues) {
  const a = meanSd(aValues), b = meanSd(bValues);
  if (a.n < 2 || b.n < 2 || a.sd === null || b.sd === null) return null;
  const va = (a.sd * a.sd) / a.n, vb = (b.sd * b.sd) / b.n;
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) return null;
  return { diff: a.mean - b.mean, se, t: (a.mean - b.mean) / se };
}

/** Share of fills falling in each market, plus the largest single share. */
function marketMix(rows) {
  const counts = {};
  let total = 0;
  for (const r of rows || []) {
    const m = (r && r.market != null && r.market !== '') ? String(r.market) : 'unknown';
    counts[m] = (counts[m] || 0) + 1;
    total += 1;
  }
  const shares = {};
  let top = null, topShare = 0;
  for (const [m, c] of Object.entries(counts)) {
    shares[m] = c / total;
    if (shares[m] > topShare) { topShare = shares[m]; top = m; }
  }
  return { counts, shares, total, topMarket: top, topShare: total ? topShare : null };
}

/**
 * Score the pre-registered test.
 *
 * @param {Array} orders  normalized rows:
 *        { pickId, gameKey, market, orderedDate:'YYYY-MM-DD'|Date,
 *          state:'ordered'|'filled'|'unfilled', clvPp, vigPp, priceGainPp }
 * @param {object} opts   { measuredFromISO, minFills, tBar, baselineClvPp,
 *                          concentrationFlag }
 *
 * `state` must be one of the three known strings. Anything else is counted in
 * `unusable` and excluded — an order in an unrecognised state is not evidence
 * for either side, and guessing which is how a pre-registered test stops being
 * one.
 */
function evaluateFillTest(orders, opts = {}) {
  const measuredFrom = opts.measuredFromISO || MEASURED_FROM_ISO;
  const minFills = opts.minFills == null ? 40 : opts.minFills;
  const tBar = opts.tBar == null ? 2 : opts.tBar;
  const baseline = opts.baselineClvPp == null ? RULE_C_BASELINE_CLV_PP : opts.baselineClvPp;
  // Not pre-registered: the pre-registration says fills must not be
  // "concentrated so heavily in one market" without naming a number. This is a
  // REPORTED FLAG, never a kill, and the threshold is stated here so it is
  // visible rather than buried.
  const concentrationFlag = opts.concentrationFlag == null ? 0.6 : opts.concentrationFlag;

  const cut = new Date(`${measuredFrom}T00:00:00Z`);
  const forward = { filled: [], unfilled: [], open: [] };
  const pilot = { filled: [], unfilled: [], open: [] };
  let unusable = 0;

  for (const r of orders || []) {
    if (!r) { unusable++; continue; }
    const state = String(r.state || '');
    if (state !== 'filled' && state !== 'unfilled' && state !== 'ordered') { unusable++; continue; }
    const d = r.orderedDate instanceof Date
      ? r.orderedDate
      : new Date(`${String(r.orderedDate).slice(0, 10)}T00:00:00Z`);
    if (isNaN(d.getTime())) { unusable++; continue; }
    const era = d >= cut ? forward : pilot;
    era[state === 'ordered' ? 'open' : state].push(r);
  }

  const decided = forward.filled.length + forward.unfilled.length;
  const fillRate = decided > 0 ? forward.filled.length / decided : null;

  const bucketOpts = { minN: minFills, tBar };
  const filledNet = summarizeBucket(forward.filled, netEdgeAtLoggedPrice, bucketOpts);
  const filledNetAtFill = summarizeBucket(forward.filled, netEdgeAtFillPrice, bucketOpts);
  const filledClv = summarizeBucket(forward.filled, (r) => r.clvPp, bucketOpts);
  const missedClv = summarizeBucket(forward.unfilled, (r) => r.clvPp, bucketOpts);

  // Adverse selection: of the CLV that was on offer across everything we
  // posted, how much did the orders that actually filled capture? A ratio near
  // 1 means the venue is not picking us off; well under 1 means the misses
  // were the good ones.
  const captureRatio = (isNum(filledClv.meanPp) && isNum(missedClv.meanPp)
    && Number(missedClv.meanPp) !== 0)
    ? Number(filledClv.meanPp) / Number(missedClv.meanPp)
    : null;

  const selection = welchT(
    clusterByGame(forward.filled, (r) => r.clvPp),
    clusterByGame(forward.unfilled, (r) => r.clvPp));

  // Kill condition 2, stated as a test rather than an invented cutoff: is
  // fill-conditional CLV significantly BELOW the rule-C baseline?
  const tVsBaseline = tOfMean(clusterByGame(forward.filled, (r) => r.clvPp), baseline);

  const mix = marketMix(forward.filled);

  const out = {
    measuredFrom,
    minFills,
    tBar,
    unusable,
    pilot: {
      _warning: 'NOT EVIDENCE. Recorded so the forward sample can be compared '
        + 'against what prompted it. Never pooled with the forward test.',
      orders: pilot.filled.length + pilot.unfilled.length + pilot.open.length,
      filled: pilot.filled.length,
      unfilled: pilot.unfilled.length,
      open: pilot.open.length,
      fillRate: (pilot.filled.length + pilot.unfilled.length) > 0
        ? pilot.filled.length / (pilot.filled.length + pilot.unfilled.length)
        : null,
    },
    forward: {
      posted: forward.filled.length + forward.unfilled.length + forward.open.length,
      filled: forward.filled.length,
      unfilled: forward.unfilled.length,
      open: forward.open.length,
      decided,
      fillRate,
      netEdge: filledNet,
      netEdgeAtFillPrice: filledNetAtFill,
      filledClv,
      missedClv,
      captureRatio,
      selection,
      marketMix: mix,
    },
  };

  out.verdict = verdictOf(filledNet, minFills, tBar);
  out.killChecks = killChecksOf({
    filledNet, filledClv, tVsBaseline, baseline, mix, minFills, concentrationFlag,
  });
  return out;
}

/**
 * The one-line read. Deliberately unable to say CONFIRMED below the
 * pre-registered sample, and unable to say it on a positive mean alone.
 */
function verdictOf(net, minFills = 40, tBar = 2) {
  if (!net || net.games === 0) return 'no forward fills yet';
  if (net.games < minFills) {
    const need = minFills - net.games;
    return `INSUFFICIENT: ${net.games} of ${minFills} fills (${need} more before this is readable)`;
  }
  if (net.t === null) return `INSUFFICIENT: ${net.games} fills but t not computable`;
  if (net.meanPp > 0 && net.t >= tBar) {
    return `CONFIRMED: fill-conditional net edge +${net.meanPp.toFixed(3)}pp, t ${net.t.toFixed(2)}`;
  }
  if (net.meanPp <= 0) {
    return `KILLED: fill-conditional net edge ${net.meanPp.toFixed(3)}pp at ${net.games} fills `
      + `(pre-registered kill condition 1), t ${net.t.toFixed(2)}`;
  }
  return `INCONCLUSIVE: mean +${net.meanPp.toFixed(3)}pp but t ${net.t.toFixed(2)} < ${tBar}`;
}

/**
 * The three pre-registered kill conditions, each evaluated explicitly and each
 * carrying its own "not yet answerable" state. A condition that cannot be
 * checked is reported as unchecked, never as passed.
 */
function killChecksOf(x) {
  const { filledNet, filledClv, tVsBaseline, baseline, mix, minFills, concentrationFlag } = x;
  const checks = [];

  checks.push({
    id: 'net_edge_nonpositive',
    text: `fill-conditional net edge <= 0 after ${minFills}+ fills`,
    status: (!filledNet || filledNet.games < minFills) ? 'not_yet_checkable'
      : (filledNet.meanPp <= 0 ? 'FIRED' : 'passed'),
    detail: filledNet && isNum(filledNet.meanPp)
      ? `${filledNet.meanPp.toFixed(3)}pp on ${filledNet.games} fills` : 'no data',
  });

  checks.push({
    id: 'clv_collapse_below_rule_c',
    text: `fill-conditional CLV significantly below the rule-C baseline of ${baseline}pp`,
    status: (tVsBaseline === null) ? 'not_yet_checkable'
      : (tVsBaseline <= -2 ? 'FIRED' : 'passed'),
    detail: (filledClv && isNum(filledClv.meanPp) && tVsBaseline !== null)
      ? `filled CLV ${filledClv.meanPp.toFixed(3)}pp vs ${baseline}pp, t ${tVsBaseline.toFixed(2)}`
      : 'no data',
  });

  checks.push({
    id: 'market_concentration',
    text: `fills concentrated in one market (> ${Math.round(concentrationFlag * 100)}% share)`,
    status: (!mix || !mix.total) ? 'not_yet_checkable'
      : (mix.topShare > concentrationFlag ? 'FLAGGED' : 'passed'),
    detail: (mix && mix.total)
      ? `${mix.topMarket} ${(mix.topShare * 100).toFixed(0)}% of ${mix.total} fills`
      : 'no data',
  });

  return checks;
}

module.exports = {
  MEASURED_FROM_ISO,
  RULE_C_BASELINE_CLV_PP,
  isNum,
  meanSd,
  tOfMean,
  rowsNeeded,
  clusterByGame,
  welchT,
  marketMix,
  netEdgeAtLoggedPrice,
  netEdgeAtFillPrice,
  summarizeBucket,
  verdictOf,
  killChecksOf,
  evaluateFillTest,
};
