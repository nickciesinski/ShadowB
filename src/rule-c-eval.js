'use strict';
// =============================================================
// src/rule-c-eval.js — did the pre-registered rule survive going forward?
//
// 2026-09-06. `src/rule-c.js` stamps every pick with `rule_c_eligible` and
// deliberately does not touch staking (see its header). The whole point of
// writing the rule down on 2026-08-31 was that rows written AFTER that date
// are an out-of-sample test of it. Nothing ever read the stamp back, so the
// test existed but was never scored. This module scores it.
//
// It is READ-ONLY ARITHMETIC over ledger rows. It never decides a stake and
// must never be imported by the pick or grade path. If a future change wants
// to gate stake on rule C, that is a separate deliberate commit made after
// this readout confirms the rule — not a flag flipped in here.
//
// THREE THINGS IT REFUSES TO DO, all of which have burned this project:
//
//  1. Pool in-sample with forward rows. The rule was FOUND by slicing the
//     735 rows it was first scored on, so its in-sample figure (-0.417pp,
//     t -2.98) is not evidence of anything. Mixing buckets would launder
//     that number into the forward result. They are reported side by side
//     and never summed.
//
//  2. Treat tickets as independent. A game's moneyline, spread and total
//     share one model state and one line move. Counting them as three
//     observations inflated a feature t-statistic from 1.58 to 4.04 on
//     2026-08-31 — from "nothing" to "significant". Everything here CLUSTERS
//     BY GAME first, exactly like src/feature-clv.js.
//
//  3. Report a null as a pass. `resolvable` stays false until the bucket has
//     enough clustered observations, and `gamesNeeded` says how far short it
//     is. A rule that has not yet been measured is not a rule that worked.
//
// The metric is net edge (CLV − vig) in probability points, which IS expected
// ROI per unit staked and is measured on every ticket — so it resolves in
// weeks instead of the hundreds of settled bets win/loss would need.
// =============================================================

// The date the rule was written down. Rows on/after this are the real test.
const PRE_REG_ISO = '2026-08-31';

/**
 * A value is only numeric if it really is one. `Number(null)` and `Number('')`
 * are both 0 and both finite, so a lazy filter would silently score a missing
 * net edge as exact break-even and pull every mean toward zero.
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
 * One-sample t against zero: "is this bucket's net edge different from
 * break-even?" Null when it cannot be computed, rather than a guessed 0.
 */
function tOfMean(values) {
  const { n, mean, sd } = meanSd(values);
  if (n < 2 || sd === null) return null;
  if (sd === 0) return null; // degenerate: no variation, t undefined
  return mean / (sd / Math.sqrt(n));
}

/**
 * How many clustered observations this bucket needs before an effect of the
 * size currently observed would clear |t| = tTarget. The honest headline of
 * a null result: not "the rule failed" but "it is this far from answerable".
 */
function rowsNeeded(mean, sd, tTarget = 1.96) {
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || mean === 0 || sd === 0) return null;
  return Math.ceil(Math.pow((tTarget * sd) / mean, 2));
}

/**
 * Collapse tickets to one observation per game — the clustering step.
 * Rows with no game key each become their own cluster: dropping them would
 * silently shrink the sample, and lumping them under one blank key would
 * fabricate a single enormous fake game.
 */
function clusterByGame(rows) {
  const games = new Map();
  let anon = 0;
  for (const r of rows || []) {
    if (!r || !isNum(r.netEdgePp)) continue;
    const v = Number(r.netEdgePp);
    const key = (r.gameKey == null || r.gameKey === '') ? `__anon_${anon++}` : String(r.gameKey);
    if (!games.has(key)) games.set(key, { sum: 0, n: 0 });
    const g = games.get(key);
    g.sum += v; g.n += 1;
  }
  return [...games.values()].map(g => g.sum / g.n);
}

/** Summarize one bucket: clustered mean net edge, t, and what it still needs. */
function summarizeBucket(rows, opts = {}) {
  const minGames = opts.minGames == null ? 30 : opts.minGames;
  const clustered = clusterByGame(rows);
  const { n, mean, sd } = meanSd(clustered);
  const t = tOfMean(clustered);
  return {
    tickets: (rows || []).length,
    games: n,
    meanNetEdgePp: mean,
    sdPp: sd,
    t,
    resolvable: n >= minGames && t !== null,
    gamesNeeded: rowsNeeded(mean, sd),
  };
}

/**
 * The one-line read on the forward bucket. Deliberately blunt, and
 * deliberately unable to say "confirmed" on a positive mean alone — a
 * positive mean with |t| below 2 is what noise looks like.
 */
function verdictOf(f) {
  if (!f || f.games === 0) return 'no forward rows yet';
  if (!f.resolvable) {
    const need = f.gamesNeeded == null ? null : Math.max(0, f.gamesNeeded - f.games);
    return need == null
      ? `not resolvable yet (${f.games} games)`
      : `not resolvable yet (${f.games} games, ~${need} more needed)`;
  }
  if (f.meanNetEdgePp > 0 && f.t >= 1.96) return 'CONFIRMED out-of-sample: positive net edge';
  if (f.meanNetEdgePp < 0 && f.t <= -1.96) return 'REJECTED out-of-sample: negative net edge';
  return `inconclusive (mean ${f.meanNetEdgePp.toFixed(3)}pp, t ${f.t.toFixed(2)})`;
}

/**
 * Welch two-sample t between two buckets' clustered means.
 *
 * This answers the question the rule actually poses — "does the filter
 * SEPARATE good tickets from bad ones?" — which is not the same question as
 * "is the filtered bucket profitable?". Both matter: separation says the
 * signal is real, level says whether it is enough to bet. A rule can pass the
 * first and still fail the second, and reporting only one hides that.
 *
 * Welch (unequal variance) rather than pooled: the eligible bucket is the
 * plus-money side, whose net edge is visibly more dispersed.
 */
function welchT(aValues, bValues) {
  const a = meanSd(aValues), b = meanSd(bValues);
  if (a.n < 2 || b.n < 2 || a.sd === null || b.sd === null) return null;
  const va = (a.sd * a.sd) / a.n, vb = (b.sd * b.sd) / b.n;
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) return null;
  return { diff: a.mean - b.mean, se, t: (a.mean - b.mean) / se };
}

/**
 * Score the pre-registered rule.
 *
 * @param {Array} rows  { date:'YYYY-MM-DD'|Date, gameKey, netEdgePp, eligible:true|false|null }
 * @param {object} opts { preRegISO, minGames }
 *
 * `eligible` must be a real boolean. null/undefined means the stamp could not
 * be evaluated (missing price or probability); those rows are counted in
 * `unlabelled` and excluded from BOTH buckets, because guessing which side a
 * row belongs on is how a pre-registered test stops being one.
 */
function evaluateRuleC(rows, opts = {}) {
  const preRegISO = opts.preRegISO || PRE_REG_ISO;
  const cut = new Date(`${preRegISO}T00:00:00Z`);
  const b = {
    inSample: { eligible: [], ineligible: [] },
    forward: { eligible: [], ineligible: [] },
  };
  let unlabelled = 0;
  for (const r of rows || []) {
    if (!r) continue;
    if (r.eligible !== true && r.eligible !== false) { unlabelled++; continue; }
    const d = r.date instanceof Date
      ? r.date
      : new Date(`${String(r.date).slice(0, 10)}T00:00:00Z`);
    if (isNaN(d.getTime())) { unlabelled++; continue; }
    const era = d >= cut ? 'forward' : 'inSample';
    b[era][r.eligible ? 'eligible' : 'ineligible'].push(r);
  }
  const out = {
    preReg: preRegISO,
    unlabelled,
    inSample: {
      eligible: summarizeBucket(b.inSample.eligible, opts),
      ineligible: summarizeBucket(b.inSample.ineligible, opts),
    },
    forward: {
      eligible: summarizeBucket(b.forward.eligible, opts),
      ineligible: summarizeBucket(b.forward.ineligible, opts),
    },
  };
  // Does the filter separate, out-of-sample? Computed on the clustered game
  // means, same as every other figure here.
  out.forward.separation = welchT(
    clusterByGame(b.forward.eligible), clusterByGame(b.forward.ineligible));
  out.inSample.separation = welchT(
    clusterByGame(b.inSample.eligible), clusterByGame(b.inSample.ineligible));
  out.verdict = verdictOf(out.forward.eligible);
  out.separationVerdict = separationVerdictOf(out.forward.separation);
  return out;
}

/**
 * The read on separation. Kept apart from `verdict` on purpose: a rule can
 * sort tickets correctly and still sort them into two losing piles.
 */
function separationVerdictOf(sep) {
  if (!sep) return 'separation not measurable yet';
  const d = `${sep.diff >= 0 ? '+' : ''}${sep.diff.toFixed(3)}pp`;
  if (sep.t >= 1.96) return `filter separates out-of-sample (${d}, t ${sep.t.toFixed(2)})`;
  if (sep.t <= -1.96) return `filter separates BACKWARDS (${d}, t ${sep.t.toFixed(2)})`;
  return `separation not established (${d}, t ${sep.t.toFixed(2)})`;
}

module.exports = { PRE_REG_ISO, isNum, meanSd, welchT, separationVerdictOf, tOfMean, rowsNeeded, clusterByGame,
  summarizeBucket, verdictOf, evaluateRuleC };
