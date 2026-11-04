'use strict';
/**
 * src/injury-tuning.js — pure maths for the weekly injury tuner.
 *
 * 2026-11-03 (Nick): "optimise the ratings for this model so they best show
 * the impact on results — automatically". scripts/injury-tuner.js does the
 * I/O; everything that decides anything lives here and is unit-tested.
 *
 * WHAT IS MEASURED. For every graded game: how far the result beat the
 * CLOSING line (home margin minus the margin the close implied; NHL uses
 * the win/loss against the closing no-vig probability). The closing line
 * already prices the injuries the market knew about, so a positive slope
 * here is injury value the market MISSED — the only part worth betting.
 *
 * HOW IT DECIDES. Per league, per rating formula (v0/v1/v2), fit
 * residual = b × injury_gap_diff on older games (TRAIN), pick the formula
 * with the strongest fit, then score that b on the last two weeks it never
 * saw (HOLDOUT). Same promotion rule as the weight optimizer
 * (src/promotion-state.js): three qualifying weeks in a row → PROMOTED and
 * the weight goes live; one week where it makes holdout worse → back to
 * QUARANTINED at weight 0. Thin weeks change nothing either way.
 */

const VARIANTS = ['v0', 'v1', 'v2'];
const HOLDOUT_DAYS = 14;
const MIN_HOLDOUT_GAMES = 30;   // games with a non-zero injury gap, holdout
const MIN_TRAIN_GAMES = 60;
const MIN_TRAIN_T = 2.0;        // slope must be clearly positive in training
const REQUIRED_STREAK = 3;
const WEIGHT_CLAMP = 5.0;       // same bound as auto-apply-weights.js
// How many sport units a 1.0 model score is worth — mirrors scoreToMarginAdj.
const SCORE_SCALE = { NBA: 8.0, NFL: 5.0, MLB: 1.5, NHL: 1.0 };
// Leagues scored on the spread (points); the rest on moneyline (probability).
const SPREAD_TARGET = new Set(['NBA', 'NFL']);

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * One row per graded game. perfRow: a performance_log row for the game's
 * spread (NBA/NFL) or moneyline (NHL) pick. features: that game's feature
 * vector at lock time. Returns { date, y, x: { v0, v1, v2 } } or null.
 */
function gameRow(league, perfRow, features) {
  if (!perfRow || !features) return null;
  const hs = num(perfRow.home_score), as = num(perfRow.away_score);
  if (hs === null || as === null) return null;
  const pickedHome = String(perfRow.pick || '').trim() === String(perfRow.home_team || '').trim();
  let y;
  if (SPREAD_TARGET.has(league)) {
    const line = num(perfRow.close_line);
    if (line === null) return null;
    const homeLine = pickedHome ? line : -line;
    y = (hs - as) + homeLine; // actual margin minus the margin the close expected (-homeLine)
  } else {
    const p = num(perfRow.close_novig_prob);
    if (p === null || hs === as) return null;
    const homeProb = pickedHome ? p : 1 - p;
    y = (hs > as ? 1 : 0) - homeProb;
  }
  const x = {};
  for (const v of VARIANTS) {
    const xv = num(features[`injury_gap_diff_${v}`]);
    x[v] = xv === null ? 0 : xv;
  }
  return { date: String(perfRow.game_date || perfRow.date || '').slice(0, 10), y, x };
}

/** Least squares through the origin: residual = b × gap. */
function fitSlope(rows, v) {
  let sxx = 0, sxy = 0, n = 0;
  for (const r of rows) { const x = r.x[v]; if (!x) continue; sxx += x * x; sxy += x * r.y; n++; }
  if (n < 3 || sxx === 0) return { b: 0, t: 0, n };
  const b = sxy / sxx;
  let sse = 0;
  for (const r of rows) { const x = r.x[v]; if (!x) continue; sse += (r.y - b * x) ** 2; }
  const se = Math.sqrt(sse / (n - 1) / sxx);
  return { b, t: se > 0 ? b / se : 0, n };
}

/** Share of squared error removed by b on games with an injury gap. */
function errorReduction(rows, v, b) {
  let base = 0, model = 0, n = 0;
  for (const r of rows) {
    const x = r.x[v]; if (!x) continue;
    base += r.y ** 2; model += (r.y - b * x) ** 2; n++;
  }
  return { lift: base > 0 ? (base - model) / base : 0, n };
}

function addDays(iso, d) {
  const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

/** This week's verdict for one league. */
function evaluateWeek(rows, todayISO) {
  const cutoff = addDays(todayISO, -HOLDOUT_DAYS);
  const train = rows.filter(r => r.date && r.date < cutoff);
  const holdout = rows.filter(r => r.date && r.date >= cutoff);

  const fits = {};
  for (const v of VARIANTS) fits[v] = fitSlope(train, v);
  // Best formula = strongest positive evidence in training.
  const best = VARIANTS.reduce((a, v) => (fits[v].t > fits[a].t ? v : a), 'v0');
  const fit = fits[best];
  const hold = errorReduction(holdout, best, fit.b);

  let verdict;
  if (fit.n < MIN_TRAIN_GAMES || hold.n < MIN_HOLDOUT_GAMES) verdict = 'insufficient';
  else if (fit.b > 0 && fit.t >= MIN_TRAIN_T && hold.lift > 0) verdict = 'qualify';
  else if (hold.lift < 0) verdict = 'degrade';
  else verdict = 'miss';

  // Weight for going live: refit on every game, using the chosen formula.
  const full = fitSlope(rows, best);
  return {
    variant: best, verdict,
    train: { n: fit.n, b: round(fit.b), t: round(fit.t) },
    holdout: { n: hold.n, lift: round(hold.lift) },
    fullFit: { n: full.n, b: round(full.b), t: round(full.t) },
    allFormulas: Object.fromEntries(VARIANTS.map(v => [v, { b: round(fits[v].b), t: round(fits[v].t), n: fits[v].n }])),
  };
}

/**
 * Convert the fitted slope into a model weight. NBA/NFL: b is points per
 * unit of gap. NHL: b is win probability per unit; probPerUnit converts
 * probability to goals (slope of the model's win-probability curve at 0).
 */
function slopeToWeight(league, b, csvDampen, probPerUnit = null) {
  let units = b;
  if (!SPREAD_TARGET.has(league)) {
    if (!probPerUnit) return 0;
    units = b / probPerUnit;
  }
  const w = units / ((SCORE_SCALE[league] || 5) * (csvDampen || 0.3));
  return round(Math.max(-WEIGHT_CLAMP, Math.min(WEIGHT_CLAMP, w)));
}

/** Promotion state machine. Returns the new league state + what happened. */
function transition(prev, week, weight, todayISO) {
  const s = { status: 'QUARANTINED', streak: 0, variant: 'v0', weight: 0, history: [], ...prev };
  let event = 'none';
  if (s.status === 'PROMOTED') {
    if (week.verdict === 'degrade') {
      Object.assign(s, { status: 'QUARANTINED', streak: 0, weight: 0 });
      event = 'demoted';
    } else if (week.verdict === 'qualify') {
      Object.assign(s, { variant: week.variant, weight });
      event = 'refit';
    }
  } else if (week.verdict === 'qualify') {
    s.streak += 1;
    if (s.streak >= REQUIRED_STREAK) {
      Object.assign(s, { status: 'PROMOTED', variant: week.variant, weight });
      event = 'promoted';
    } else event = 'streak';
  } else if (week.verdict === 'miss' || week.verdict === 'degrade') {
    s.streak = 0;
    event = 'reset';
  }
  s.history = [...(s.history || []), { date: todayISO, verdict: week.verdict, variant: week.variant, holdoutLift: week.holdout.lift, holdoutGames: week.holdout.n, event }].slice(-26);
  return { state: s, event };
}

function round(x) { return Math.round(x * 1000) / 1000; }

module.exports = {
  gameRow, fitSlope, errorReduction, evaluateWeek, slopeToWeight, transition,
  VARIANTS, HOLDOUT_DAYS, MIN_HOLDOUT_GAMES, REQUIRED_STREAK, SPREAD_TARGET,
};
