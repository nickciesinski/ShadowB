'use strict';
const { getTeamInjuryScore } = require('./injury-impact');
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
  // 2026-08-09 — plausibility gate on the scoring rates.
  //
  // Found in production the morning after the feature-vocabulary fix. Aliasing
  // offense_rs_diff to offense_ppg_diff connected weight 1.2 to this value,
  // and the value was carrying SEASON TOTALS rather than per-game rates:
  // offense_rs_diff came out at 13.3 and contributed 15.97, while every other
  // feature in the model sat at or below 0.70. One corrupt input was the model.
  //
  // The corruption pre-dated the alias and was harmless only because nothing
  // weighted it — the same way mlb_run_diff sat at -5825 for months. That is
  // precisely why this gate belongs here and not only at collection: a feature
  // can be wrong for a long time and only become dangerous when something
  // finally reads it. scoreMarket() is an unbounded linear sum with no
  // clamping, so any out-of-range input silently becomes the whole model.
  //
  // Note defense was CORRECT (0.315) while offense was not, so this is not a
  // blanket collection failure — see the diagnostic logging in enrichMLB.
  const RATE_RANGE = {
    MLB: [2, 8],      // runs per game
    NBA: [85, 135],   // points per game (or offensive rating)
    NFL: [8, 45],     // points per game
    NHL: [1.5, 5.5],  // goals per game
  };
  const rate = (v, side) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    const rng = RATE_RANGE[league];
    if (!rng) return n;
    if (n < rng[0] || n > rng[1]) {
      console.log(`[game-features][${league}] implausible ${side} rate ${n} `
        + `(expected ${rng[0]}-${rng[1]}) — zeroed`);
      return 0;
    }
    return n;
  };
  const hOff = rate(h.offRating || h.runsPerGame || h.goalsFor || h.pointsFor, 'home offense');
  const aOff = rate(a.offRating || a.runsPerGame || a.goalsFor || a.pointsFor, 'away offense');
  const hDef = rate(h.defRating || h.runsAllowedPerGame || h.goalsAgainst || h.pointsAgainst, 'home defense');
  const aDef = rate(a.defRating || a.runsAllowedPerGame || a.goalsAgainst || a.pointsAgainst, 'away defense');

  f.offense_ppg_diff = (hOff - aOff) / norm.ppg;
  f.defense_papg_diff = (aDef - hDef) / norm.ppg; // lower defense = better, so invert

  // 2026-08-08 BUGFIX — vocabulary mismatch between weights and features.
  // config/model-params.MLB.json weights run_differential_diff (1.7 ML /
  // 2.2 spread), defense_ra_diff (1.4 / 1.3) and offense_rs_diff (1.2 / 1.1)
  // -- its three LARGEST weights -- but extractFeatures never emitted those
  // names. scoreMarket() does `features[key]`, gets undefined, and skips
  // silently, so 57% of the MLB moneyline weight mass was landing on nothing
  // and the model ran on 43% of its intended signal. That is the real reason
  // the top contributors were four copies of recent form: they were among the
  // few weighted features that actually existed.
  //
  // These are aliases of the identical, already correctly-signed computations
  // above (positive always favours home), NOT new estimates. Emitting both
  // names keeps any consumer of the old keys working.
  f.offense_rs_diff = f.offense_ppg_diff;
  f.defense_ra_diff = f.defense_papg_diff;

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

  // 2026-08-08 BUGFIX — these four were formDiff * {1.0, 1.1, 1.2, 1.3}: the
  // SAME number scaled by four constants, correlation exactly 1.0. The old
  // comment said "the optimizer will learn which windows matter", but there
  // was nothing to learn — every weight vector over four copies of one
  // variable is equivalent to a single scalar. That is why the MLB deep sweep
  // came back with a flat weight space, and why recent form looked
  // "systematically overweighted": its four copies carried ~1.65 of combined
  // weight and ~90% of the moneyline model's total signal.
  //
  // data-collection.js now records results in order and emits real L1/L3/L5
  // windows. Where a genuine window exists we use it; otherwise we fall back
  // to the L10 figure UNSCALED, because inventing a spread between windows is
  // what created the fake variation in the first place. Falling back means a
  // duplicate value, which is honest — the information really is the same.
  const winDiff = (hKey, aKey) => {
    const hv = parseFloat(h[hKey]);
    const av = parseFloat(a[aKey]);
    return (Number.isFinite(hv) && Number.isFinite(av)) ? hv - av : formDiff;
  };
  f.recent_form_l10_diff = formDiff;
  f.recent_form_l5_diff = winDiff('formL5', 'formL5');
  f.recent_form_l3_diff = winDiff('formL3', 'formL3');
  f.recent_form_l1_diff = winDiff('formL1', 'formL1');

  // Momentum/trend (form vs season average — positive = trending up)
  f.momentum_diff = (hForm - hPct) - (aForm - aPct);
  f.trend_diff = f.momentum_diff * 0.8; // slightly dampened version

  // ── Home/away splits ──
  f.home_away_split_diff = 0.02; // slight home bias default
  // home_ice_advantage is NHL's name for the same thing and carries weight
  // (0.1 ML / 0.12 spread); without the alias it was silently skipped.
  f.home_ice_advantage = league === 'NHL' ? 0.03 : 0;
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

  // ── Injury features (from Injury Summary + Prop_Status scratches) ──
  const homeAbbr = (home.abbr || home.Abbr || '').toUpperCase();
  const awayAbbr = (away.abbr || away.Abbr || '').toUpperCase();
  const homeInjScore = getTeamInjuryScore(league, homeAbbr);
  const awayInjScore = getTeamInjuryScore(league, awayAbbr);
  f.home_injury_weight = homeInjScore;           // 0-1, higher = more injured
  f.away_injury_weight = awayInjScore;
  f.injury_weight_diff = awayInjScore - homeInjScore; // positive = away more hurt = home advantage
  f.total_injury_weight = homeInjScore + awayInjScore; // both banged up = more variance
  f.severe_injury_factor = Math.max(homeInjScore, awayInjScore) > 0.5 ? 1 : 0;
  f.injury_advantage = Math.max(-1, Math.min(1, f.injury_weight_diff * 2)); // normalized -1 to 1

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

  // ── League-specific signals ──
  // Each league gets one unique feature derived from its most predictive stat.
  // These capture sport-specific dynamics the generic model misses.

  if (league === 'NBA') {
    // Pace-adjusted net rating: efficiency in context of game speed
    const hOff = parseFloat(h.offRating) || 0;
    const hDef = parseFloat(h.defRating) || 0;
    const aOff = parseFloat(a.offRating) || 0;
    const aDef = parseFloat(a.defRating) || 0;
    const hPaceR = parseFloat(h.pace) || 100;
    const aPaceR = parseFloat(a.pace) || 100;
    const hPaceAdj = (hOff - hDef) * (hPaceR / 100);
    const aPaceAdj = (aOff - aDef) * (aPaceR / 100);
    f.nba_pace_adj_net = (hPaceAdj - aPaceAdj) / norm.rating;
  } else {
    f.nba_pace_adj_net = 0;
  }

  if (league === 'MLB') {
    // Run differential per game: single best predictor in baseball
    const hRuns = parseFloat(h.runsPerGame) || 0;
    const hRA = parseFloat(h.runsAllowedPerGame) || 0;
    const aRuns = parseFloat(a.runsPerGame) || 0;
    const aRA = parseFloat(a.runsAllowedPerGame) || 0;
    const rawRunDiff = ((hRuns - hRA) - (aRuns - aRA)) / norm.ppg;
    // 2026-08-08 — sanity gate. scoreMarket() is an UNBOUNDED linear sum with
    // no clamping anywhere downstream, so one malformed stat can dominate every
    // other feature. This ran at -5825 for months (season totals mistaken for
    // per-game rates) and was invisible only because the feature carries no
    // weight. A plausible value here is well inside +/-3; anything past that is
    // upstream corruption, so zero it and say so rather than let it through.
    f.mlb_run_diff = Number.isFinite(rawRunDiff) && Math.abs(rawRunDiff) <= 3
      ? rawRunDiff
      : 0;
    // Same value under the name the weight vector actually uses (1.7 on
    // moneyline, 2.2 on spread -- the single largest weight in the file).
    f.run_differential_diff = f.mlb_run_diff;

    // 2026-08-08 — MLB team batting/pitching, newly collected. These are
    // genuinely NEW information, not renames: nothing in the model saw team
    // OPS, batting average or WHIP before.
    //
    // Deliberately NOT adding era_diff / pitcher_era_diff / pitcher_quality_
    // diff here. Starter ERA already reaches the model through a different
    // door: computePitcherAdj turns the ERA gap into a runs adjustment (capped
    // +/-2.0) added straight to the margin as starterAdj in game-model.js.
    // Weighting ERA features on top would count the same signal twice.
    // WHIP is not in starterAdj, so it is additive rather than duplicative.
    const opsD = diff(h.ops, a.ops);
    f.ops_diff = opsD !== null ? opsD / 0.1 : 0;          // ~0.1 OPS = 1 unit
    const avgD = diff(h.battingAvg, a.battingAvg);
    f.batting_avg_diff = avgD !== null ? avgD / 0.02 : 0; // ~20 pts of AVG
    // WHIP inverted: LOWER is better, so away-minus-home keeps the convention
    // that positive favours home.
    const whipD = diff(a.whip, h.whip);
    f.whip_diff = whipD !== null ? whipD / 0.15 : 0;
    if (Number.isFinite(rawRunDiff) && Math.abs(rawRunDiff) > 3) {
      console.log(`[game-features][MLB] implausible mlb_run_diff ${rawRunDiff.toFixed(1)} `
        + `(runs ${hRuns}/${hRA} vs ${aRuns}/${aRA}) — zeroed`);
    }
  } else {
    f.mlb_run_diff = 0;
    // Present-but-zero rather than undefined: an absent key is silently
    // skipped by scoreMarket(), which is exactly the failure being fixed here.
    // For non-MLB leagues the generic point differential is the right stand-in.
    f.run_differential_diff = Number.isFinite(f.point_differential_diff)
      ? f.point_differential_diff : 0;
    f.ops_diff = 0;
    f.batting_avg_diff = 0;
    f.whip_diff = 0;
  }

  if (league === 'NFL') {
    // Points margin per game: proxy for turnover-driven scoring
    const hPF = parseFloat(h.pointsFor) || 0;
    const hPA = parseFloat(h.pointsAgainst) || 0;
    const aPF = parseFloat(a.pointsFor) || 0;
    const aPA = parseFloat(a.pointsAgainst) || 0;
    f.nfl_points_margin = ((hPF - hPA) - (aPF - aPA)) / norm.ppg;
    // 2026-08-08 — opp_points_diff is an alias of the (already inverted)
    // defensive differential. The rest of NFL's dead weight (turnover_impact
    // 1.8, efficiency_diff, yards_diff, red_zone_diff, third_down_diff) is
    // genuinely uncollected data, not a naming problem -- see the audit note
    // in the commit. Those need new stat collection and are NOT faked here.
    f.opp_points_diff = f.defense_papg_diff;

    // 2026-08-08 — NFL carried the largest dead weight of any league:
    // turnover_impact 1.8 (the single biggest missing weight anywhere),
    // yards_diff 0.45, red_zone_diff 0.35, third_down_diff 0.3,
    // opp_yards_diff 0.3, pass/rush_yards_diff. All weighted, none collected.
    // Normalisers below put each roughly on a +/-1 scale so no single one
    // dominates the unbounded sum in scoreMarket().
    const ydsD = diff(h.yardsPerGame, a.yardsPerGame);
    f.yards_diff = ydsD !== null ? ydsD / 50 : 0;
    // Opponent yards inverted: fewer allowed is better.
    const oppYdsD = diff(a.oppYardsPerGame, h.oppYardsPerGame);
    f.opp_yards_diff = oppYdsD !== null ? oppYdsD / 50 : 0;
    const passD = diff(h.passYardsPerGame, a.passYardsPerGame);
    f.pass_yards_diff = passD !== null ? passD / 40 : 0;
    const rushD = diff(h.rushYardsPerGame, a.rushYardsPerGame);
    f.rush_yards_diff = rushD !== null ? rushD / 30 : 0;
    const thirdD = diff(h.thirdDownPct, a.thirdDownPct);
    f.third_down_diff = thirdD !== null ? thirdD / 8 : 0;   // pct points
    const rzD = diff(h.redZonePct, a.redZonePct);
    f.red_zone_diff = rzD !== null ? rzD / 12 : 0;          // pct points

    // Turnover margin: takeaways minus giveaways, home vs away. This is what
    // turnover_impact (1.8) is asking for and it is the classic NFL margin
    // stat.
    //
    // Divisor 15 is calibrated, not arbitrary. Every other NFL feature lands
    // near ~0.9 for a good-vs-average matchup (nfl_points_margin 0.94,
    // yards_diff 0.68, third_down_diff 0.75), and features have to share a
    // scale because scoreMarket() is an unbounded linear sum. At /10 a routine
    // 14-turnover season gap produced 1.4, which against weight 1.8 was 2.52 --
    // more than the ENTIRE pre-existing score for that game, pushing model_prob
    // to 0.96. Turnover margin deserves to be the largest single input here;
    // it does not deserve to be the only one.
    const hTO = parseFloat(h.takeaways) - parseFloat(h.giveaways);
    const aTO = parseFloat(a.takeaways) - parseFloat(a.giveaways);
    f.turnover_impact = (Number.isFinite(hTO) && Number.isFinite(aTO))
      ? (hTO - aTO) / 15 : 0;

    // efficiency_diff (0.8) is deliberately left at 0. Unlike the above its
    // intended meaning is not recoverable -- it could be yards/play,
    // points/yard, or DVOA-style. Inventing a definition for an existing
    // weight would silently change what that 0.8 multiplies. Needs a decision,
    // not a guess.
    f.efficiency_diff = 0;
  } else {
    f.nfl_points_margin = 0;
    f.opp_points_diff = 0;
    f.yards_diff = 0; f.opp_yards_diff = 0; f.pass_yards_diff = 0;
    f.rush_yards_diff = 0; f.third_down_diff = 0; f.red_zone_diff = 0;
    f.turnover_impact = 0; f.efficiency_diff = 0;
  }

  if (league === 'NHL') {
    // Goal differential: most predictive simple stat in hockey
    const hGF = parseFloat(h.goalsFor) || 0;
    const hGA = parseFloat(h.goalsAgainst) || 0;
    const aGF = parseFloat(a.goalsFor) || 0;
    const aGA = parseFloat(a.goalsAgainst) || 0;
    f.nhl_goal_diff = ((hGF - hGA) - (aGF - aGA)) / norm.ppg;
    // 2026-08-08 — same vocabulary mismatch as MLB, and worse. NHL weights
    // goal_differential_diff at 1.8 (moneyline) and 3.0 (spread) -- the single
    // largest weight in any param file -- plus defense_ga_diff 1.4 and
    // offense_gf_diff 1.2, none of which extractFeatures emitted. Only 57% /
    // 55% / 51% of NHL weight mass was reaching the model. Aliases of the
    // identical, already correctly-signed computations above.
    f.goal_differential_diff = f.nhl_goal_diff;
    f.offense_gf_diff = f.offense_ppg_diff;
    f.defense_ga_diff = f.defense_papg_diff;
  } else {
    f.nhl_goal_diff = 0;
    // Present-but-zero, never undefined: scoreMarket() silently skips missing
    // keys, which is the failure being fixed.
    f.goal_differential_diff = 0;
    f.offense_gf_diff = 0;
    f.defense_ga_diff = 0;
  }

  // ── SP (sharp/power) features — computed from market odds ──
  // These get filled in by the game model after market parsing (see the
  // "Wire sp_prob_home/away..." block in game-model.js — sp_prob_home/away
  // and sp_edge_ml_home/away, sp_edge_spread_home/away were wired to real
  // market-consensus + line-shopping-dispersion data on 2026-07-07; init to
  // 0 here is just the safe default when market data for a side is missing.
  // sp_pred_margin, sp_edge_total, sp_pred_total are also set in game-model.js.
  // 2026-06-10: init to 0, not 0.5. These are never populated before scoreMarket
  // runs, and the moneyline weights put 3.0 on each — so 0.5*3.0 + 0.5*3.0 injected
  // a constant +3.0 into every ML score (= +1.35 run MLB home tilt) on top of the
  // legitimate home-field term in projectMargin. 0 neutralizes the dead constant.
  f.sp_prob_home = 0;
  f.sp_prob_away = 0;
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


/**
 * Decompose a market score into per-feature contributions.
 * Returns sorted array of { feature, weight, value, contribution } (largest |contribution| first).
 * The top entry is the "primary edge driver" for this market.
 *
 * @param {Object} features - From extractFeatures()
 * @param {Object} marketWeights - { featureName: coefficient, ... }
 * @returns {Array<{feature: string, weight: number, value: number, contribution: number}>}
 */
function decomposeScore(features, marketWeights) {
  if (!marketWeights || Object.keys(marketWeights).length === 0) return [];

  const contributions = [];
  for (const [key, weight] of Object.entries(marketWeights)) {
    const val = features[key];
    if (val !== undefined && val !== null && isFinite(weight) && weight !== 0) {
      contributions.push({
        feature: key,
        weight,
        value: val,
        contribution: val * weight,
      });
    }
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return contributions;
}

module.exports = {
  extractFeatures,
  scoreMarket,
  scoreToMarginAdj,
  scoreToTotalAdj,
  decomposeScore,
};
