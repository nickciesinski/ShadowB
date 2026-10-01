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

/**
 * Group features that move together, so reweighting has something real to act on.
 *
 * 2026-09-10. Tuning 27 weights implies 27 things to tune. They are not: on the
 * post-2026-08-31 sample run_differential_diff and whip_diff correlate at
 * r=0.888. Two weights pointing at one underlying quantity cannot be tuned
 * independently — raising one and lowering the other is a no-op the search will
 * happily wander around forever, and a Bonferroni correction over 27 "tests"
 * that are really 2-3 is both too harsh on count and too lenient on structure.
 *
 * Single-link clustering at |r| >= threshold. Single-link (join a feature to a
 * cluster if it is close to ANY member) is deliberate: for "can these two
 * weights be tuned separately?", one tight pairing anywhere in the group is
 * enough to make the answer no.
 *
 * @param {Array} rows      { gameKey, feature, contribution } - clv unused
 * @param {object} opts     { minGames = 30, threshold = 0.7 }
 * @returns {{clusters: Array, nFeatures: number, threshold: number}}
 *          clusters are arrays of feature names, largest first; a feature with
 *          no partner appears as a cluster of one.
 */
function collinearityClusters(rows, opts = {}) {
  const minGames = opts.minGames ?? 30;
  const threshold = opts.threshold ?? 0.7;

  // One value per (feature, game), same clustering step as attributeByFeature.
  const byFeature = new Map();
  for (const r of rows) {
    if (!r || !r.feature || r.gameKey == null) continue;
    const c = Number(r.contribution);
    if (!Number.isFinite(c)) continue;
    if (!byFeature.has(r.feature)) byFeature.set(r.feature, new Map());
    const games = byFeature.get(r.feature);
    const g = games.get(r.gameKey) || { c: 0, n: 0 };
    g.c += c; g.n += 1;
    games.set(r.gameKey, g);
  }

  const names = [...byFeature.keys()].filter(f => byFeature.get(f).size >= minGames);

  // Correlate only over games BOTH features appear in, otherwise the pairing is
  // measured on two different populations.
  const pairR = (a, b) => {
    const ga = byFeature.get(a), gb = byFeature.get(b);
    const xs = [], ys = [];
    for (const [k, v] of ga) {
      const w = gb.get(k);
      if (!w) continue;
      xs.push(v.c / v.n); ys.push(w.c / w.n);
    }
    return xs.length >= minGames ? corr(xs, ys) : null;
  };

  // Union-find over pairs above the threshold.
  const parent = new Map(names.map(n => [n, n]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const r = pairR(names[i], names[j]);
      if (r === null) continue;
      if (Math.abs(r) >= threshold) { union(names[i], names[j]); pairs.push({ a: names[i], b: names[j], r }); }
    }
  }

  const groups = new Map();
  for (const n of names) {
    const root = find(n);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  }
  const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  return {
    clusters,
    pairs,
    nFeatures: names.length,
    // What the feature count is really worth once duplicates collapse.
    effectiveFeatures: clusters.length,
    threshold,
  };
}

// =============================================================
// 2026-10-01 — three more defects, found at check-in #1. All three made the
// report blind to a real effect rather than inventing one: starter_ip_l3_diff
// read t=+0.26 under the old join and t=+3.49 with all three fixed.
//
//   1. SIDE. Feature values are game-level - positive favours the HOME team
//      (or, for a total's live score, the OVER). CLV is measured for the side
//      we PICKED. Correlating the two raw lets an effect on home picks cancel
//      an equal effect on away picks. Every value is now turned to the picked
//      side first: "how much did this feature favour what we bet?"
//
//   2. LOCK TIME. The model re-scores every run until the game starts (about
//      8.6 vectors per NFL pick), but the published pick and its price lock on
//      the first one. Averaging all of them mixes in vectors computed AFTER the
//      price was taken - a Friday injury report then "predicts" a line move we
//      could never have bet. Only the vector that existed at lock is used.
//
//   3. MARKET GROUP. A home-minus-away difference says nothing about over vs
//      under. Sides (moneyline + spread) and totals are tested separately; for
//      the candidate diffs, the totals table is effectively a placebo.
// =============================================================

// Vectors are written at lock (median gap ~0 min); this only absorbs the write.
const LOCK_SLACK_MS = 30 * 60 * 1000;

/** 'sides' | 'totals' | null for a ledger market string. */
function marketGroup(market) {
  const m = String(market || '').toLowerCase();
  if (m === 'moneyline' || m === 'spread') return 'sides';
  if (m === 'total' || m === 'over' || m === 'under') return 'totals';
  return null;
}

/**
 * +1 if the pick is the side a positive feature value favours (home, or over),
 * -1 if the other side, null if the pick text cannot be read. Reads the pick
 * text because `performance_log.selection` is NULL on every v2_clv row.
 */
function pickSign(led) {
  if (!led) return null;
  const group = marketGroup(led.market);
  const pick = String(led.pick || '').toLowerCase();
  if (!pick) return null;
  if (group === 'totals') {
    if (pick.startsWith('over')) return 1;
    if (pick.startsWith('under')) return -1;
    return null;
  }
  if (group === 'sides') {
    const home = String(led.home_team || '').toLowerCase();
    const away = String(led.away_team || '').toLowerCase();
    const isHome = home && pick.includes(home);
    const isAway = away && pick.includes(away);
    if (isHome && !isAway) return 1;
    if (isAway && !isHome) return -1;
  }
  return null;
}

/**
 * One vector per pick: the latest one written at or before the pick locked.
 * Picks with only post-lock vectors are dropped, never back-filled - a later
 * vector would carry information the locked price did not have.
 *
 * @param feats    rows with { pick_id, created_at, ... }
 * @param byPickId Map pick_id -> ledger row with { locked_at }
 * @returns {{ vectors: Array, dropped: number }}
 */
function lockTimeVectors(feats, byPickId) {
  const best = new Map();
  const seen = new Set();
  for (const f of feats) {
    const led = byPickId.get(f.pick_id);
    if (!led) continue;
    seen.add(f.pick_id);
    const t = Date.parse(f.created_at);
    const lock = Date.parse(led.locked_at);
    if (!Number.isFinite(t) || !Number.isFinite(lock)) continue;
    if (t > lock + LOCK_SLACK_MS) continue;
    const cur = best.get(f.pick_id);
    if (!cur || t > Date.parse(cur.created_at)) best.set(f.pick_id, f);
  }
  return { vectors: [...best.values()], dropped: seen.size - best.size };
}

/** Deterministic PRNG so a report re-run gives the same p-value. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Game-level matrix: one row per game, one column per feature, plus mean CLV.
 * A feature missing from a game counts as 0 - "favoured neither side".
 */
function gameMatrix(rows, features) {
  const games = new Map();
  for (const r of rows) {
    if (!r || r.gameKey == null || !r.feature) continue;
    const c = Number(r.contribution), v = Number(r.clv);
    if (!Number.isFinite(c) || !Number.isFinite(v)) continue;
    if (!games.has(r.gameKey)) games.set(r.gameKey, { x: new Map(), picks: new Map() });
    const g = games.get(r.gameKey);
    const fx = g.x.get(r.feature) || { s: 0, n: 0 };
    fx.s += c; fx.n += 1; g.x.set(r.feature, fx);
    // CLV is per pick; key on pickId when present so a pick is counted once,
    // not once per feature.
    g.picks.set(r.pickId ?? `${r.feature}:${g.picks.size}`, v);
  }
  const keys = [...games.keys()];
  const X = features.map(f => keys.map(k => {
    const fx = games.get(k).x.get(f);
    return fx ? fx.s / fx.n : 0;
  }));
  const y = keys.map(k => {
    const vs = [...games.get(k).picks.values()];
    return vs.reduce((a, b) => a + b, 0) / vs.length;
  });
  return { keys, X, y };
}

function zscore(xs) {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return sd > 0 ? xs.map(x => (x - m) / sd) : null;
}

/**
 * Test the candidates as ONE bundle, not one at a time.
 *
 * Shuffles game-level CLV across games `perms` times and asks how often noise
 * produces a bundle statistic as large as the real one. Shuffling y keeps the
 * features' correlations with each other intact, so 39 collinear features are
 * not treated as 39 independent tests - the multiple-comparison correction is
 * built in. Two statistics: sum of r^2 (many small effects) and max |r| (one
 * standout).
 */
function bundleTest(rows, opts = {}) {
  const perms = opts.perms ?? 2000;
  const minGames = opts.minGames ?? 30;
  const features = [...new Set(rows.map(r => r && r.feature).filter(Boolean))].sort();
  const { keys, X, y } = gameMatrix(rows, features);
  const n = keys.length;
  if (n < minGames || !features.length) return { nGames: n, nFeatures: features.length, resolvable: false };

  const Z = X.map(zscore).filter(Boolean);
  const zy = zscore(y);
  if (!Z.length || !zy) return { nGames: n, nFeatures: Z.length, resolvable: false };

  const stats = (yy) => {
    let ss = 0, mx = 0;
    for (const zx of Z) {
      let s = 0;
      for (let i = 0; i < n; i++) s += zx[i] * yy[i];
      const r = s / (n - 1);
      ss += r * r; if (Math.abs(r) > mx) mx = Math.abs(r);
    }
    return { ss, mx };
  };

  const real = stats(zy);
  const rand = mulberry32(opts.seed ?? 4242);
  const yy = zy.slice();
  let geSS = 0, geMx = 0;
  for (let p = 0; p < perms; p++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [yy[i], yy[j]] = [yy[j], yy[i]];
    }
    const s = stats(yy);
    if (s.ss >= real.ss) geSS++;
    if (s.mx >= real.mx) geMx++;
  }
  return {
    nGames: n, nFeatures: Z.length, resolvable: true, perms,
    sumR2: real.ss, maxAbsR: real.mx,
    pSumR2: (geSS + 1) / (perms + 1), pMaxR: (geMx + 1) / (perms + 1),
  };
}

/**
 * Score a FROZEN composite (pre-registered weights) against game-level CLV.
 * Features are z-scored within the sample being scored, so the weights are
 * the only thing carried over from the sample that suggested them.
 */
function frozenComposite(rows, weights) {
  const features = Object.keys(weights);
  const { keys, X, y } = gameMatrix(rows.filter(r => r && r.feature in weights), features);
  const n = keys.length;
  if (n < 3) return { nGames: n, r: null, t: null };
  const comp = new Array(n).fill(0);
  features.forEach((f, j) => {
    const z = zscore(X[j]);
    if (z) for (let i = 0; i < n; i++) comp[i] += weights[f] * z[i];
  });
  const r = corr(comp, y);
  return { nGames: n, r, t: tStat(r, n) };
}

module.exports = {
  corr, tStat, gamesNeeded, attributeByFeature, collinearityClusters,
  LOCK_SLACK_MS, marketGroup, pickSign, lockTimeVectors, bundleTest, frozenComposite,
};
