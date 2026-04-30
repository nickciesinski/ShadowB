'use strict';
// =============================================================
// src/game-features.js — Extract per-game feature vectors for
// the weighted linear model.
//
// Given home/away team stats, computes all stat differentials
// and combined values that map to weight CSV keys. Each feature
// is a normalized number centered around 0 (for diffs) or 0.5
// (for combined). The game model multiplies each feature by its
// CSV weight and sums to get a raw score per market.
//
// Feature naming matches the Weights CSV key column exactly so
// lookups are O(1) by name.
// =============================================================

/**
 * Extract all features for a game.
 *
 * @param {Object} home - Home team stats from teamsMap
 * @param {Object} away - Away team stats from teamsMap
 * @param {Object} [scheduleInfo] - { homeDaysOff, awayDaysOff, homeB2B, awayB2B }
 * @param {string} league
 * @returns {Object} - { featureName: normalizedValue, ... }
 */
function extractFeatures(home, away, scheduleInfo, league) {
  const f = {};
  const h = home || {};
  const a = away || {};

  // ── Helper: parse and diff two numeric fields ──
  const diff = (hVal, aVal) => {
    const hNum = parseFloat(hVal);
    const aNum = parseFloat(aVal);
    if (!isFinite(hNum) || !isFinite(aNum)) return null;
    return hNum - aNum;
  };

  const combine = (hVal, aVal) => {
    const hNum = parseFloat(hVal);
    const aNum = parseFloat(aVal);
    if (!isFinite(hNum) || !isFinite(aNum)) return null;
    return (hNum + aNum) / 2;
  };

  // ── Win% and point differential ──
  const hPct = parseFloat(h.pct) || 0.5;
  const aPct = parseFloat(a.pct) || 0.5;
  f.point_differential_diff = hPct - aPct; // normalized already (0-1 range)

  // ── Offensive/Defensive stats ──
  // These get normalized to roughly -1 to +1 range by sport-specific divisors
  const NORM = {
    NBA: { ppg: 20, rating: 15, pace: 10, fg: 10, three: 10, reb: 10, ast: 10, to: 5 },
    MLB: { ppg: 4, rating: 4, pace: 1, fg: 1, three: 1, reb: 1, ast: 1, to: 1 },
    NHL: { ppg: 2, rating: 2, pace: 1, fg: 1, three: 1, reb: 1, ast: 1, to: 1 },
    NFL: { ppg: 10, rating: 10, pace: 1, fg: 1, three: 1, reb: 1, ast: 1, to: 5 },
  };
  const norm = NORM[league] || NORM.NBA;

  // Offense/defense per-game stats
  const hOff = parseFloat(h.offRating || h.runsPerGame || h.goalsFor || h.pointsFor) || 0;
  const aOff = parseFloat(a.offRating || a.runsPerGame || a.goalsFor || a.pointsFor) || 0;
  const hDef = parseFloat(h.defRating || h.runsAllowedPerGame || h.goalsAgainst || h.pointsAgainst) || 0;
  const aDef = parseFloat(a.defRating || a.runsAllowedPerGame || a.goalsAgainst || a.pointsAgainst) || 0;

  f.offense_ppg_diff = (hOff - aOff) / norm.ppg;
  f.defense_papg_diff = (aDef - hDef) / norm.ppg; // lower defense = better, so invert

  // Rating diffs (NBA-specific but safe for all)
  const offRDiff = diff(h.offRating, a.offRating);
  const defRDiff = diff(a.defRating, h.defRating); // invert: lower def rating = better
  f.offensive_rating_diff = offRDiff !== null ? offRDiff / norm.rating : 0;
  f.defensive_rating_diff = defRDiff !== null ? defRDiff / norm.rating : 0;
  f.net_rating_diff = (f.offensive_rating_diff + f.defensive_rating_diff) / 2;

  // ── Recent form (multiple windows) ──
  const hForm = parseFloat(h.recentFormPct) || hPct;
  const aForm = parseFloat(a.recentFormPct) || aPct;
  const formDiff = hForm - aForm;

  // We don't have per-window form data in team stats, so we derive
  // synthetic windows: L10 = recentFormPct, L5/L3/L1 = scaled versions
  // The optimizer will learn which windows matter
  f.recent_form_l10_diff = formDiff;
  f.recent_form_l5_diff = formDiff * 1.1;  // recent windows are noisier but more signal
  f.recent_form_l3_diff = formDiff * 1.2;
  f.recent_form_l1_diff = formDiff * 1.3;

  // Momentum/trend (form vs season average — positive = trending up)
  f.momentum_diff = (hForm - hPct) - (aForm - aPct);
  f.trend_diff = f.momentum_diff * 0.8; // slightly dampened version

  // ── Home/away splits ──
  f.home_away_split_diff = 0.02; // slight home bias default
  f.home_court_advantage = league === 'NBA' ? 0.15 :
                           league === 'NFL' ? 0.12 :
                           league === 'MLB' ? 0.04 :
                           league === 'NHL' ? 0.03 : 0.05;

  // ── Shooting/efficiency (NBA/NFL specific) ──
  f.fg_percentage_diff = 0;    // Not in current team stats
  f.three_point_diff = 0;
  f.rebounds_diff = 0;
  f.assists_diff = 0;
  f.turnovers_diff = 0;
  f.opponent_fg_diff = 0;

  // ── Pace ──
  const hPace = parseFloat(h.pace) || 0;
  const aPace = parseFloat(a.pace) || 0;
  f.pace_diff = hPace && aPace ? (hPace - aPace) / norm.pace : 0;
  f.pace_factor = hPace && aPace ? ((hPace + aPace) / 2 - 100) / norm.pace : 0;
  f.pace_combined = hPace && aPace ? (hPace + aPace) / 200 : 0.5; // normalized to ~0.5

  // ── Combined stats (for totals market) ──
  f.fg_percentage_combined = 0.5;
  f.three_point_combined = 0.5;
  f.turnovers_combined = 0.5;

  // ── Injury features (placeholder — Sprint 4 will populate) ──
  f.injury_weight_diff = 0;
  f.severe_injury_factor = 0;
  f.injury_advantage = 0;
  f.home_injury_weight = 0;
  f.away_injury_weight = 0;
  f.total_injury_weight = 0;

  // ── Schedule/rest ──
  if (scheduleInfo) {
    const homeDays = parseFloat(scheduleInfo.homeDaysOff) || 1;
    const awayDays = parseFloat(scheduleInfo.awayDaysOff) || 1;
    f.rest_diff = (homeDays - awayDays) / 3; // normalized: 3 days diff = 1.0
    f.home_b2b = scheduleInfo.homeB2B ? -0.5 : 0;
    f.away_b2b = scheduleInfo.awayB2B ? 0.5 : 0;
  } else {
    f.rest_diff = 0;
    f.home_b2b = 0;
    f.away_b2b = 0;
  }

  // ── SP (sharp/power) features — computed from market odds ──
  // These get filled in by the game model after market parsing
  f.sp_prob_home = 0.5;
  f.sp_prob_away = 0.5;
  f.sp_edge_ml_home = 0;
  f.sp_edge_ml_away = 0;
  f.sp_edge_spread_home = 0;
  f.sp_edge_spread_away = 0;
  f.sp_pred_margin = 0;
  f.sp_edge_total = 0;
  f.sp_pred_total = 0;

  return f;
}

/**
 * Score a market using the weighted linear combination of features.
 * Missing weights default to 0 (feature ignored).
 *
 * @param {Object} features - From extractFeatures()
 * @param {Object} marketWeights - { featureName: coefficient, ... } from Weights CSV
 * @returns {number} - Raw weighted score (unbounded)
 */
function scoreMarket(features, marketWeights) {
  if (!marketWeights || Object.keys(marketWeights).length === 0) return 0;

  let score = 0;
  for (const [key, weight] of Object.entries(marketWeights)) {
    const featureVal = features[key];
    if (featureVal !== undefined && featureVal !== null && isFinite(weight)) {
      score += featureVal * weight;
    }
  }
  return score;
}

/**
 * Convert a raw market score to a margin adjustment.
 * The score is the CSV-weighted signal; scale it to points/runs/goals.
 *
 * @param {number} score - From scoreMarket()
 * @param {string} league
 * @returns {number} - Margin adjustment in sport units
 */
function scoreToMarginAdj(score, league) {
  // Scale factors: how many points a "1.0 score" represents
  const SCALE = { NBA: 8.0, NFL: 5.0, MLB: 1.5, NHL: 1.0 };
  return score * (SCALE[league] || 5.0);
}

/**
 * Convert a raw market score to a total adjustment.
 */
function scoreToTotalAdj(score, league) {
  const SCALE = { NBA: 6.0, NFL: 4.0, MLB: 1.0, NHL: 0.8 };
  return score * (SCALE[league] || 3.0);
}

module.exports = {
  extractFeatures,
  scoreMarket,
  scoreToMarginAdj,
  scoreToTotalAdj,
};
