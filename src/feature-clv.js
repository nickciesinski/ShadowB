'use strict';
// =============================================================
// src/feature-clv.js — which feature is actually earning its weight?
//
// 2026-08-31. The model logs 48 features, their weights and their per-pick
// contributions on every pick, and until today none of it had ever been
// measured against an outcome: prediction_features had no join key to the
// ledger and its own `result` column was 100% NULL. So "the model's net edge
// is +0.20pp" was the only thing anyone could say, and the obvious follow-up
// - which parts of it are working? - was unanswerable.
//
// This module answers it against CLV rather than win/loss, because CLV has a
// standard deviation of ~2.6pp against win/loss's ~50pp. That is the whole
// reason the roadmap made CLV primary: it is the only measurement that can
// resolve a feature-level effect inside a season.
//
// TWO STATISTICAL TRAPS THIS EXISTS TO AVOID, both of which produced a
// false positive on the first pass through this data:
//
//   1. Pseudo-replication. Each game generates a moneyline, a spread and a
//      total pick that share one model state and one line move. Treating them
//      as three independent observations inflated run_differential_diff's
//      t-statistic from 1.58 to 4.04 - from "nothing yet" to "highly
//      significant". Everything here CLUSTERS BY GAME first.
//
//   2. Multiple comparisons. Testing ~19 features and reporting the best one
//      finds a t of 2.5 in pure noise most of the time. daily-validation.js
//      makes the same warning about segments. Every t here is reported
//      against a Bonferroni-corrected threshold for the number of features
//      actually tested.
//
// It reports what is NOT yet resolvable as prominently as what is, and says
// how many more games each answer needs. A monitoring tool that only ever
// finds signal is not a monitoring tool.
// =============================================================

/** Pearson correlation. Null when undefined (constant input, n<3). */
function corr(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * t for a correlation at n observations.
 *
 * A perfect |r| = 1 makes the usual denominator zero. Returning null there
 * would report the strongest possible relationship as "not significant",
 * which is exactly backwards. Clamp instead, so t stays large and finite.
 */
function tStat(r, n) {
  if (r === null || r === undefined || !Number.isFinite(r) || n < 3) return null;
  const d = Math.max(1e-12, 1 - r * r);
  return (r * Math.sqrt(n - 2)) / Math.sqrt(d);
}

/**
 * Games needed to resolve an effect of this size at ~80% power, two-sided,
 * after Bonferroni. The honest headline of any null result: not "no effect"
 * but "this many games short of being able to tell".
 */
function gamesNeeded(r, nFeatures = 1) {
  if (r === null || r === 0) return null;
  // z for alpha/2 after Bonferroni, and z for 80% power.
  const alpha = 0.05 / Math.max(1, nFeatures);
  // Inverse normal, Beasley-Springer-Moro is overkill here; a small table
  // covers the range of feature counts we ever test.
  const zA = alpha >= 0.05 ? 1.960 : alpha >= 0.01 ? 2.576
    : alpha >= 0.005 ? 2.807 : alpha >= 0.001 ? 3.291 : 3.481;
  const zB = 0.8416;
  const fisher = 0.5 * Math.log((1 + Math.abs(r)) / (1 - Math.abs(r)));
  if (!Number.isFinite(fisher) || fisher === 0) return null;
  return Math.ceil(Math.pow((zA + zB) / fisher, 2) + 3);
}

/**
 * Per-feature CLV attribution, clustered by game.
 *
 * @param {Array} rows  { gameKey, feature, contribution, clv }
 * @param {object} opts { minGames = 30 }
 * @returns {{ features: Array, nFeatures: number, tThreshold: number }}
 */
function attributeByFeature(rows, opts = {}) {
  const minGames = opts.minGames ?? 30;

  // 1. collapse to one observation per (feature, game) — the clustering step.
  const byFeature = new Map();
  for (const r of rows) {
    if (!r || !r.feature || r.gameKey == null) continue;
    const c = Number(r.contribution), v = Number(r.clv);
    if (!Number.isFinite(c) || !Number.isFinite(v)) continue;
    if (!byFeature.has(r.feature)) byFeature.set(r.feature, new Map());
    const games = byFeature.get(r.feature);
    if (!games.has(r.gameKey)) games.set(r.gameKey, { c: 0, v: 0, n: 0 });
    const g = games.get(r.gameKey);
    g.c += c; g.v += v; g.n += 1;
  }

  const eligible = [];
  for (const [feature, games] of byFeature) {
    if (games.size < minGames) {
      eligible.push({ feature, nGames: games.size, r: null, t: null,
        meanClvPp: null, resolvable: false, reason: 'below minimum sample' });
      continue;
    }
    const xs = [], ys = [];
    for (const g of games.values()) { xs.push(g.c / g.n); ys.push(g.v / g.n); }
    const r = corr(xs, ys);
    eligible.push({ feature, nGames: games.size, r, t: tStat(r, games.size),
      meanClvPp: (ys.reduce((a, b) => a + b, 0) / ys.length) * 100, resolvable: true });
  }

  // 2. Bonferroni over the features actually tested, not all features seen.
  const tested = eligible.filter(f => f.resolvable);
  const nFeatures = Math.max(1, tested.length);
  const tThreshold = nFeatures <= 1 ? 1.960 : nFeatures <= 5 ? 2.576
    : nFeatures <= 10 ? 2.807 : nFeatures <= 50 ? 3.291 : 3.481;

  for (const f of eligible) {
    f.significant = f.t !== null && Math.abs(f.t) >= tThreshold;
    f.gamesNeeded = f.significant ? null : gamesNeeded(f.r, nFeatures);
    f.shortBy = (f.gamesNeeded !== null && f.nGames) ? Math.max(0, f.gamesNeeded - f.nGames) : null;
  }

  eligible.sort((a, b) => Math.abs(b.t ?? 0) - Math.abs(a.t ?? 0));
  return { features: eligible, nFeatures, tThreshold };
}

module.exports = { corr, tStat, gamesNeeded, attributeByFeature };
