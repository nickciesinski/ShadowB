// =============================================================
// src/calibrated-display.mjs — what the app shows, honestly
//
// 2026-08-31. The app has been showing the model's raw confidence and edge:
// an average claimed +13pp against a measured +0.2pp, with 78% of picks at
// 10/10. That display is why three months of reviews felt better than the
// results. This module replaces it with the calibrated numbers.
//
// Shared, single source of truth: copied into web/ by web/scripts/copy-params.mjs
// (config/ and src/ live outside web/ and are not otherwise bundled on Vercel).
// Written as ESM so the Next route can import it unchanged.
//
// What the numbers mean now:
//   edge = calibrated win probability - the probability implied by the price
//          we would actually pay. That IS expected return per unit staked.
//   confidence = a scale over that edge, NOT a percentile. A percentile scale
//          would hand 10/10 to the best of a bad slate, which is the same
//          fiction in a new coat. On this scale almost everything sits at 1,
//          because on measured data only ~1.5% of picks clear zero. That is
//          the finding, not a bug - and it makes the rare good pick findable.
// =============================================================

// Full confidence at +2pp of real edge. Chosen because a 2pp edge per bet is
// roughly the top of what a beatable market realistically offers; anything
// claiming more is a modelling error, which is exactly what we just removed.
export const EDGE_AT_FULL_CONFIDENCE = 0.02;
export const MIN_UNITS = 0.01;
export const MAX_UNITS = 0.5;

/** Implied probability of an American price. Null on junk. */
export function impliedProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || Math.abs(o) < 100) return null;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

/**
 * Expected return per unit staked, in probability points (a fraction).
 * Uses the best price available, since that is what we would actually take.
 */
export function calibratedEdge(calibratedProb, odds, bestOdds) {
  if (calibratedProb === null || calibratedProb === undefined || calibratedProb === '') return null;
  const p = Number(calibratedProb);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const priced = impliedProb(bestOdds) ?? impliedProb(odds);
  if (priced === null) return null;
  return p - priced;
}

/** 1..10 over real edge. Returns null when there is no calibrated edge to scale. */
export function calibratedConfidence(edge) {
  if (edge === null || edge === undefined) return null;
  const e = Number(edge);
  if (!Number.isFinite(e)) return null;
  if (e <= 0) return 1;
  const scaled = 1 + 9 * Math.min(1, e / EDGE_AT_FULL_CONFIDENCE);
  return Math.max(1, Math.min(10, Math.round(scaled)));
}

/** Stake implied by that confidence. Minimum, not zero, so the pick stays visible. */
export function calibratedUnits(confidence) {
  if (confidence === null || confidence === undefined) return null;
  const c = Number(confidence);
  if (!Number.isFinite(c)) return null;
  const frac = (Math.max(1, Math.min(10, c)) - 1) / 9;
  const u = MIN_UNITS + frac * (MAX_UNITS - MIN_UNITS);
  return Math.round(u * 100) / 100;
}

/**
 * One call for a row. Returns { calibrated:false } untouched when the league
 * has no fitted map (EPL today) - the app must be able to say "not calibrated"
 * rather than quietly showing a raw number as if it were calibrated.
 */
export function displayFor(row) {
  const edge = calibratedEdge(row.calibrated_prob, row.odds, row.best_odds);
  if (edge === null) return { calibrated: false, edge: null, confidence: null, units: null };
  const confidence = calibratedConfidence(edge);
  return { calibrated: true, edge, confidence, units: calibratedUnits(confidence) };
}
