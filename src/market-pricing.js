'use strict';
// =============================================================
// src/market-pricing.js â Pure math functions for pricing & sizing
// No external dependencies. Deterministic. Testable.
// =============================================================

// ââ Odds Conversion âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * American odds â implied probability (0-1).
 * e.g. -150 â 0.60, +200 â 0.333
 */
function americanToImpliedProb(odds) {
  const o = parseFloat(odds);
  if (!isFinite(o) || o === 0) return 0.5;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

/**
 * Implied probability (0-1) â American odds.
 * e.g. 0.60 â -150, 0.333 â +200
 */
function impliedProbToAmerican(prob) {
  if (prob <= 0 || prob >= 1) return prob >= 1 ? -10000 : +10000;
  if (prob >= 0.5) {
    return Math.round(-100 * prob / (1 - prob));
  }
  return Math.round(100 * (1 - prob) / prob);
}

/**
 * Remove vig from a two-outcome market to get true (no-vig) probabilities.
 * Takes both sides' implied probs (which sum to >1 due to vig).
 * Returns [trueProb1, trueProb2] summing to 1.0.
 */
function removeVig(impliedProb1, impliedProb2) {
  const total = impliedProb1 + impliedProb2;
  if (total <= 0) return [0.5, 0.5];
  return [impliedProb1 / total, impliedProb2 / total];
}

// ââ Edge Calculation âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Calculate edge: model probability vs market implied probability.
 * Positive = model sees more value than the market.
 * Returns edge as a percentage (e.g., 3.5 means 3.5% edge).
 */
function calcEdge(modelProb, marketImpliedProb) {
  if (!isFinite(modelProb) || !isFinite(marketImpliedProb)) return 0;
  return (modelProb - marketImpliedProb) * 100;
}

// ââ Projection â Probability âââââââââââââââââââââââââââââââââââââ

/**
 * Convert a projected point margin to a spread cover probability.
 * Uses a logistic approximation calibrated to historical NFL/NBA/MLB/NHL data.
 *
 * @param {number} projectedMargin - Model's projected margin (positive = home favored)
 * @param {number} marketSpread - Market spread for the picked side (e.g., -3.5 for home -3.5)
 * @param {string} league - 'NBA','NFL','MLB','NHL'
 * @returns {number} probability (0-1) that the picked side covers
 *
 * The key insight: if projected margin is -5 and the spread is -3.5 (home favored by 3.5),
 * the home team is expected to exceed the spread by 1.5 points. How likely is that?
 * Historical standard deviation of margin vs spread residuals differs by sport.
 */
function marginToSpreadCoverProb(projectedMargin, marketSpread, league) {
  // Standard deviation of actual margin vs expected margin, by sport.
  // These are approximate from historical data. They represent how
  // "noisy" game outcomes are relative to projections.
  const MARGIN_STDEV = {
    NBA: 11.0,   // NBA games swing ~11 points from expectation
    NFL: 13.5,   // NFL is very high-variance
    MLB: 3.2,    // MLB run margins are tighter
    NHL: 2.5,    // NHL goal margins are tightest
  };

  const stdev = MARGIN_STDEV[league] || 10.0;

  // The spread "edge" is how much better we expect the pick to perform
  // vs what the market spread implies. Positive = we expect to beat the spread.
  // For the picked side: if we're picking home at -3.5, and we project home by -5,
  // the advantage is |projectedMargin| - |marketSpread| in the pick's direction.
  // Simplification: assume projectedMargin and marketSpread are both from the same
  // team's perspective. The edge = projectedMargin - marketSpread.
  const advantage = projectedMargin - marketSpread;

  // Logistic CDF approximation: P(cover) = 1 / (1 + exp(-k * advantage))
  // k â 1.7 / stdev gives a good approximation to the normal CDF
  const k = 1.7 / stdev;
  return 1 / (1 + Math.exp(-k * advantage));
}

/**
 * Convert a projected total to an over/under probability.
 *
 * @param {number} projectedTotal - Model's projected total points/runs/goals
 * @param {number} marketTotal - Market's total line
 * @param {string} league
 * @returns {number} probability (0-1) that the game goes OVER the market total
 */
function totalToOverProb(projectedTotal, marketTotal, league) {
  // Standard deviation of actual totals vs projected totals
  const TOTAL_STDEV = {
    NBA: 18.0,   // NBA totals vary widely
    NFL: 12.0,   // NFL totals are noisy
    MLB: 2.8,    // MLB run totals are tighter
    NHL: 2.0,    // NHL goal totals are tightest
  };

  const stdev = TOTAL_STDEV[league] || 10.0;
  const advantage = projectedTotal - marketTotal;
  const k = 1.7 / stdev;
  return 1 / (1 + Math.exp(-k * advantage));
}

/**
 * Convert a projected win probability to a moneyline edge.
 * This is the simplest case â model prob vs market implied prob.
 *
 * @param {number} projectedWinProb - Model's win probability (0-1)
 * @param {number} marketOdds - American odds from the market
 * @returns {{ edge: number, marketImpliedProb: number }}
 */
function winProbToMLEdge(projectedWinProb, marketOdds) {
  const marketImplied = americanToImpliedProb(marketOdds);
  return {
    edge: calcEdge(projectedWinProb, marketImplied),
    marketImpliedProb: marketImplied,
  };
}

// ââ Unit Sizing âââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Calculate units to wager based on edge, uncertainty, and market quality.
 * Replaces the old confidenceToUnits() which took a 1-10 GPT guess.
 *
 * @param {number} edgePct - Edge percentage (e.g., 3.5)
 * @param {number} uncertaintyScore - 0-1, higher = more uncertain (reduces sizing)
 * @param {number} marketQualityScore - 0-1, higher = better market data (boosts sizing)
 * @param {number} performanceMod - League/market modifier from Supabase (e.g., 1.15 or 0.7)
 * @returns {number} units to bet (0.01 minimum, 0.5 maximum)
 */
function calcUnits(edgePct, uncertaintyScore, marketQualityScore, performanceMod) {
  // Base units: proportional to edge, scaled by a multiplier.
  // 1% edge â 0.05 units, 3% edge â 0.15 units, 5% edge â 0.25 units
  const edgeMultiplier = 0.05; // units per 1% of edge
  let units = Math.max(0, edgePct) * edgeMultiplier;

  // Reduce by uncertainty (missing data, small sample, etc.)
  // uncertaintyScore 0 = fully certain, 1 = maximum uncertainty
  const uncertaintyPenalty = 1 - (uncertaintyScore * 0.6); // max 60% reduction
  units *= Math.max(0.4, uncertaintyPenalty);

  // Boost/reduce by market quality (number of books, line freshness)
  // marketQualityScore 0 = poor data, 1 = excellent data
  const qualityMultiplier = 0.6 + (marketQualityScore * 0.4); // range 0.6-1.0
  units *= qualityMultiplier;

  // Apply league/market performance modifier
  units *= (performanceMod || 1.0);

  // Clamp: 0.01 floor (every game gets a pick), 0.5 cap
  units = Math.max(0.01, Math.min(0.5, units));

  // Round to 2 decimal places
  return Math.round(units * 100) / 100;
}

/**
 * Derive a display confidence (1-10) from edge for backwards compatibility
 * with the Performance Log schema. This is cosmetic, not used for sizing.
 */
function edgeToDisplayConfidence(edgePct) {
  if (edgePct <= 0) return 1;
  if (edgePct < 0.5) return 2;
  if (edgePct < 1.0) return 3;
  if (edgePct < 1.5) return 4;
  if (edgePct < 2.0) return 5;
  if (edgePct < 3.0) return 6;
  if (edgePct < 4.0) return 7;
  if (edgePct < 5.5) return 8;
  if (edgePct < 7.0) return 9;
  return 10;
}

// ââ Market Quality Scoring âââââââââââââââââââââââââââââââââââââââ

/**
 * Score market data quality based on available bookmaker data.
 *
 * @param {number} numBooks - Number of bookmakers offering this market
 * @param {number} priceDispersion - Std dev of prices across books (higher = more disagreement)
 * @param {boolean} hasConsensus - Whether a consensus line exists
 * @returns {number} quality score 0-1
 */
function scoreMarketQuality(numBooks, priceDispersion, hasConsensus) {
  let score = 0;

  // More books = better price discovery
  if (numBooks >= 8) score += 0.4;
  else if (numBooks >= 4) score += 0.3;
  else if (numBooks >= 2) score += 0.2;
  else score += 0.1;

  // Low price dispersion = market agrees = higher confidence in line
  if (priceDispersion <= 5) score += 0.3;
  else if (priceDispersion <= 15) score += 0.2;
  else score += 0.1;

  // Consensus line exists
  if (hasConsensus) score += 0.3;

  return Math.min(1.0, score);
}

/**
 * Score data uncertainty based on what inputs are available.
 *
 * @param {Object} flags
 * @param {boolean} flags.hasTeamStats - Real offensive/defensive ratings available
 * @param {boolean} flags.hasRecentForm - Rolling recent game data available
 * @param {boolean} flags.hasRestData - Days off / back-to-back info available
 * @param {boolean} flags.hasInjuryData - Key player availability known
 * @returns {number} uncertainty score 0-1 (lower = more certain)
 */
function scoreUncertainty(flags) {
  let missing = 0;
  let total = 4;

  if (!flags.hasTeamStats) missing++;
  if (!flags.hasRecentForm) missing++;
  if (!flags.hasRestData) missing++;
  if (!flags.hasInjuryData) missing++;

  return missing / total;
}

// ââ Heavy Favorite Cap âââââââââââââââââââââââââââââââââââââââââââ

/**
 * Cap units on heavy ML favorites. Historically these win often but
 * one upset wipes out multiple wins worth of profit.
 * (Preserves the existing logic from predictions.js line 679)
 *
 * @param {number} odds - American odds
 * @param {number} units - Calculated units
 * @returns {number} Capped units
 */
function applyHeavyFavCap(odds, units) {
  if (odds < -200) return 0.01;
  return units;
}

module.exports = {
  // Odds conversion
  americanToImpliedProb,
  impliedProbToAmerican,
  removeVig,
  // Edge
  calcEdge,
  // Projections â probabilities
  marginToSpreadCoverProb,
  totalToOverProb,
  winProbToMLEdge,
  // Sizing
  calcUnits,
  edgeToDisplayConfidence,
  applyHeavyFavCap,
  // Quality scoring
  scoreMarketQuality,
  scoreUncertainty,
};
