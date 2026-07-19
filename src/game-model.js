'use strict';
// =============================================================
// src/game-model.js â Deterministic prediction engine
// Replaces GPT-4o in trigger4. For each game, produces picks
// on all 3 markets (moneyline, spread, total) using formula-based
// projections compared against market odds.
//
// Sprint 2 (April 2026): Now consumes enriched stats via
// stat-features.js instead of raw W-L only. Uses offensive/
// defensive ratings, pace, recent form, and rest data.
//
// Inputs:  game objects (from buildGameObjects), team stats, weights
// Outputs: array of pick objects ready for logPicksToPerformanceLog
// =============================================================

const {
  americanToImpliedProb,
  impliedProbToAmerican,
  removeVig,
  calcEdge,
  marginToSpreadCoverProb,
  totalToOverProb,
  winProbToMLEdge,
  calcUnits,
  roundUnits,
  edgeToDisplayConfidence,
  applyHeavyFavCap,
  scoreMarketQuality,
  scoreUncertainty,
} = require('./market-pricing');

const {
  teamStrength: computeTeamStrength,
  restAdjustment: computeRestAdj,
  homeAdvantage: getHomeAdvantage,
  recentForm,
  paceAdjustment,
  dataCompleteness,
  setTunableFactors,
  getTunableFactor,
} = require('./stat-features');

const {
  extractFeatures,
  scoreMarket,
  scoreToMarginAdj,
  scoreToTotalAdj,
  decomposeScore,
} = require('./game-features');

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 * Used by MLB run line logic for more calibrated cover probabilities.
 */
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

const { loadCalibration, getCalibrationMultiplier } = require('./calibration');
const { loadInjuryImpact } = require('./injury-impact');

// ââ League-specific constants ââââââââââââââââââââââââââââââââ

/**
 * Average total points/runs/goals per game by league.
 * Used as a baseline when team-specific pace data isn't available.
 */
const AVG_TOTAL = {
  NBA: 226,
  NFL: 46,
  MLB: 8.8,
  NHL: 6.2,
};

/**
 * Points/runs/goals per unit of win% differential.
 * Maps a team strength gap (in win% terms) to expected margin.
 * e.g., NBA: a 10% win% gap â 4.0 point expected margin.
 */
const STRENGTH_TO_MARGIN = {
  NBA: 40.0,   // 0.10 win% diff â 4.0 point margin
  NFL: 28.0,   // 0.10 win% diff â 2.8 point margin
  MLB:  8.0,   // 0.10 win% diff â 0.8 run margin
  NHL:  5.0,   // 0.10 win% diff â 0.5 goal margin
};

// ââ Core Projection Functions ââââââââââââââââââââââââââââââââ

/**
 * Project the point margin for a game.
 * Positive = home team favored.
 *
 * Sprint 2: Now uses stat-features for strength, rest, home advantage,
 * and recent form instead of inline calculations.
 *
 * @param {number} homeStrength - 0-1 rating from stat-features
 * @param {number} awayStrength - 0-1 rating from stat-features
 * @param {string} league
 * @param {number} restAdj - rest-based margin adjustment from stat-features
 * @param {number} homeFormAdj - recent form modifier for home team
 * @param {number} awayFormAdj - recent form modifier for away team
 * @returns {number} projected margin (home perspective)
 */
function projectMargin(homeStrength, awayStrength, league, restAdj, homeFormAdj, awayFormAdj) {
  const strengthDiff = homeStrength - awayStrength;
  const rawMargin = strengthDiff * (STRENGTH_TO_MARGIN[league] || 20);
  const homeAdv = getHomeAdvantage(league);

  // Recent form: convert form differential to margin points
  // A +0.05 form advantage â 0.5-2 points depending on sport
  const formDiff = (homeFormAdj || 0) - (awayFormAdj || 0);
  const formInfluence = getTunableFactor('margin_form_influence', 0.5);
  const formMargin = formDiff * (STRENGTH_TO_MARGIN[league] || 20) * formInfluence

  return rawMargin + homeAdv + (restAdj || 0) + formMargin;
}

/**
 * Project the total points/runs/goals for a game.
 * Uses market total as anchor, adjusted by team strength and pace.
 *
 * Sprint 2: Now incorporates pace data for NBA.
 *
 * @param {number} homeStrength
 * @param {number} awayStrength
 * @param {number} marketTotal - The market's posted total line
 * @param {string} league
 * @param {number} paceAdj - pace-based total adjustment from stat-features
 * @returns {number} projected total
 */
function projectTotal(homeStrength, awayStrength, marketTotal, league, paceAdj) {
  const avgTotal = AVG_TOTAL[league] || marketTotal;

  // Combined team strength: two strong teams â more scoring (slightly),
  // two weak teams â less scoring. This is a mild adjustment.
  const combinedStrength = (homeStrength + awayStrength) / 2;
  const strengthDeviation = combinedStrength - 0.5;

  // Total adjustment: scale by league average total to get appropriate magnitude
  const strengthAdj = strengthDeviation * avgTotal * 0.04;

  // Pace adjustment (mainly NBA â other sports return 0)
  const paceDamp = getTunableFactor('total_pace_dampening', 0.3);
  const totalPaceAdj = (paceAdj || 0) * paceDamp

  // Anchor heavily to market total. 2026-05-31: raised default 0.80 -> 0.95.
  // The 20% blend toward AVG_TOTAL produced a structural Over bias on lines below
  // the league average (e.g., +0.16 runs at line 8.0). The market line already
  // encodes the league environment; pulling it back to AVG_TOTAL adds bias, not
  // signal. Sims showed this single change drops MLB Over rate from 70% to ~62%.
  const anchor = getTunableFactor('total_market_anchor', 0.95);
  return marketTotal * anchor + (AVG_TOTAL[league] || marketTotal) * (1 - anchor) + strengthAdj + totalPaceAdj;
}

/**
 * Project win probability for moneyline.
 * Derived from projected margin using sport-specific conversion.
 *
 * @param {number} projectedMargin - positive = home favored
 * @param {string} league
 * @returns {number} home win probability (0-1)
 */
function projectWinProb(projectedMargin, league) {
  return marginToSpreadCoverProb(projectedMargin, 0, league);
}

// ── Simple "second opinion" model for disagreement detection ──────
/**
 * Naive win probability using only raw W-L record + home advantage.
 * No CSV weights, no form, no rest, no injuries — deliberately simple
 * so it serves as an independent check on the main model.
 */
function simpleWinProb(homeStats, awayStats, league) {
  const homePct = parseFloat(homeStats.pct) || 0.5;
  const awayPct = parseFloat(awayStats.pct) || 0.5;
  const homeAdv = { NBA: 0.035, NFL: 0.030, MLB: 0.025, NHL: 0.025 }[league] || 0.03;
  // Simple log5 formula: P(A beats B) = (pA - pA*pB) / (pA + pB - 2*pA*pB)
  const pA = Math.max(0.15, Math.min(0.85, homePct + homeAdv));
  const pB = Math.max(0.15, Math.min(0.85, awayPct));
  const log5 = (pA - pA * pB) / (pA + pB - 2 * pA * pB);
  return Math.max(0.15, Math.min(0.85, log5));
}

/**
 * Compute disagreement between main model and simple model.
 * Returns 0 (full agreement) to 1 (max disagreement).
 * Used as a confidence penalty — disagreement reduces unit sizing.
 */

/**
 * Compute prediction variance from multiple projection signals.
 * Measures how much different model components agree on the outcome.
 * Returns a variance score (0 = tight agreement, 1 = high uncertainty).
 *
 * Inputs: array of win probability estimates from different signals.
 * Uses standard deviation of estimates, normalized to 0-1 scale.
 */
function predictionVariance(probEstimates) {
  if (!probEstimates || probEstimates.length < 2) return 0;
  const valid = probEstimates.filter(p => p != null && !isNaN(p));
  if (valid.length < 2) return 0;

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sumSqDiff = valid.reduce((sum, p) => sum + (p - mean) ** 2, 0);
  const stdDev = Math.sqrt(sumSqDiff / valid.length);

  // Normalize: stdDev of 0.15 (very high for win probs) maps to variance=1.0
  // stdDev of 0.02 (tight agreement) maps to ~0.13
  return Math.min(1.0, stdDev / 0.15);
}

function modelDisagreement(mainProb, simpleProb, betType) {
  if (betType === 'over' || betType === 'under') {
    return 0; // Simple model has no total projection
  }
  const mainFavorsHome = mainProb > 0.5;
  const simpleFavorsHome = simpleProb > 0.5;

  if (mainFavorsHome === simpleFavorsHome) {
    // Same direction — disagreement is magnitude difference
    return Math.min(1.0, Math.abs(mainProb - simpleProb) * 2);
  } else {
    // Opposite directions — significant disagreement
    return Math.min(1.0, 0.5 + Math.abs(mainProb - simpleProb));
  }
}



// ââ Pick Generation ââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate all 3 picks (ML, spread, total) for a single game.
 *
 * Sprint 2: Uses stat-features for team strength, rest, form, and pace.
 *
 * @param {Object} game - From buildGameObjects: { home, away, commence, markets }
 * @param {Object} teamsMap - { teamName: { wins, losses, pct, offRating, defRating, ... } }
 * @param {Object} weights - Parsed weights (currently unused, reserved for Sprint 5)
 * @param {string} league - 'MLB', 'NBA', 'NHL', 'NFL'
 * @param {Object} [scheduleInfo] - Optional: { homeDaysOff, awayDaysOff, homeB2B, awayB2B }
 * @returns {Array} Array of 3 pick objects
 */
function generateGamePicks(game, teamsMap, weights, league, scheduleInfo, gameWeather, pitcherData) {
  // Team stats
  const homeStats = teamsMap[game.home] || {};
  const awayStats = teamsMap[game.away] || {};

  // ââ Sprint 2: Use stat-features for all computations ââ

  // Team strengths (now using off/def ratings, scoring diff, not just W-L)
  const homeStr = computeTeamStrength(homeStats, league);
  const awayStr = computeTeamStrength(awayStats, league);

  // Rest adjustment (now includes back-to-back detection)
  const restAdj = computeRestAdj(scheduleInfo, league);

  // Recent form modifiers
  const homeFormAdj = recentForm(homeStats);
  const awayFormAdj = recentForm(awayStats);

  // Pace adjustment for totals
  const paceAdj = paceAdjustment(homeStats, awayStats, league);

  // Extract full feature vector for CSV weight scoring
  const features = extractFeatures(homeStats, awayStats, scheduleInfo, league);


  // ── Simple model "second opinion" for disagreement signal ──
  const simpleHomeProb = simpleWinProb(homeStats, awayStats, league);
  // Core projection: margin (home perspective, positive = home favored)
  const baseMargin = projectMargin(homeStr, awayStr, league, restAdj, homeFormAdj, awayFormAdj);

  // ── Starting-player quality adjustment (2026-07-09) ──────────────────────
  // The `pitcherData` param now carries league-specific starter data:
  //   MLB → { pitcherAdj, homePitcher, awayPitcher }  (src/pitcher-data.js)
  //   NHL → { goalieAdj, goalieTotalAdj, homeGoalie, awayGoalie } (src/goalie-data.js)
  // Both adjustments are in the game's scoring units (runs/goals), home
  // perspective, positive = home advantage.

  // MLB probable pitcher adjustment (positive = home pitcher advantage)
  const pitcherAdj = (league === 'MLB' && pitcherData?.pitcherAdj) ? pitcherData.pitcherAdj : 0;
  if (pitcherAdj !== 0) {
    console.log(`[game-model] ${game.away}@${game.home}: pitcher adj = ${pitcherAdj.toFixed(2)} runs (${pitcherData.awayPitcher?.name || 'TBD'} vs ${pitcherData.homePitcher?.name || 'TBD'})`);
  }

  // NHL starting goalie adjustment (positive = home goalie advantage).
  // Gated by tunable factor `goalie_adj_scale` (param_auto_goalie_adj_scale in
  // config/model-params.NHL.json), seeded at 0.5 — conservative start for a
  // newly-wired signal that can't be live-validated until the season resumes
  // in October (same convention as 554fea1 / e6ee86c).
  const goalieScale = getTunableFactor('goalie_adj_scale', 0.5);
  const goalieAdj = (league === 'NHL' && pitcherData?.goalieAdj)
    ? pitcherData.goalieAdj * goalieScale : 0;
  if (goalieAdj !== 0) {
    console.log(`[game-model] ${game.away}@${game.home}: goalie adj = ${goalieAdj.toFixed(2)} goals (${pitcherData.awayGoalie?.name || 'TBD'} vs ${pitcherData.homeGoalie?.name || 'TBD'}, scale=${goalieScale})`);
  }

  // Unified starter adjustment fed into margin projections below.
  const starterAdj = pitcherAdj + goalieAdj;

  // CSV-weighted adjustment: if weights exist for moneyline/spread, blend in
  const mlWeights = (weights && weights.moneyline) || {};
  const spreadWeights = (weights && weights.spread) || {};
  const totalWeights = (weights && weights.total) || {};

  // ── Revive sp_*_total signals (2026-06-10) ──────────────────────────────
  // sp_edge_total (wt 1.6) and sp_pred_total (wt 0.55) were initialized to 0 in
  // game-features.js and never populated before totalScore was computed, so the
  // two highest-weighted total features were inert. The totals model ran almost
  // entirely on small _diff weights, letting the market-anchor blend dominate
  // direction (Over on sub-8.8 lines, Under on inflated lines). Wire them to a
  // genuine, market-relative MLB total estimate from team run rates. This is
  // zero-mean across the league (it only leans Over when the two teams' actual
  // scoring rates exceed the posted line) and contributes 0 when rate data is
  // missing — so non-MLB and thin-data games are unchanged. Bounded to keep the
  // signal from overpowering the market line.
  if (league === 'MLB') {
    const hRS = parseFloat(homeStats.runsPerGame);
    const hRA = parseFloat(homeStats.runsAllowedPerGame);
    const aRS = parseFloat(awayStats.runsPerGame);
    const aRA = parseFloat(awayStats.runsAllowedPerGame);
    const tMkt = (game.markets.totals || []).find(o => o.outcome === 'Over')
              || (game.markets.totals || []).find(o => o.outcome === 'Under');
    const tLine = tMkt ? parseFloat(tMkt.point) : NaN;
    if (isFinite(hRS) && isFinite(hRA) && isFinite(aRS) && isFinite(aRA) && isFinite(tLine)) {
      // Symmetric expected runs: each team's offense blended with the opponent's
      // run-prevention. expTotal = (hRS+aRS+hRA+aRA)/2.
      const expTotal = (hRS + aRS + hRA + aRA) / 2;
      // Measure THIS matchup against a league-average matchup (AVG_TOTAL), not
      // against the line's absolute level. This keeps the signal zero-mean: an
      // average matchup contributes 0 regardless of where the line sits, so it
      // adds matchup-specific lean without reintroducing a structural Over push.
      const matchupDev = expTotal - (AVG_TOTAL.MLB || 8.8);
      features.sp_pred_total = Math.max(-2.5, Math.min(2.5, matchupDev));
      features.sp_edge_total = Math.max(-0.4, Math.min(0.4, totalToOverProb(tLine + matchupDev, tLine, 'MLB') - 0.5));
    }
  }

  // ── Extend sp_*_total revival to NBA/NFL/NHL (2026-07-07) ────────────────
  // The 6/10 fix above was MLB-only. NBA/NFL/NHL total blocks carry the same
  // sp_edge_total/sp_pred_total weights (~3.2/1.1, config/model-params.*.json)
  // sitting on permanently-zero features since inception — same dead-signal
  // shape, just never revived. Mirrors the MLB approach exactly: matchup
  // scoring rate vs. league-average matchup (AVG_TOTAL), zero-mean, 0 when
  // data is missing. Field names per stat-features.js's scoringDifferential:
  // NBA/NFL use pointsFor/pointsAgainst, NHL uses goalsFor/goalsAgainst.
  // Bounds are scaled off market-pricing.js's TOTAL_STDEV (the same stdevs
  // totalToOverProb uses), at the same ~0.9x-stdev ratio the MLB bound (2.5
  // vs stdev 2.8) already uses.
  const TOTAL_REVIVAL_FIELDS = {
    NBA: { for: 'pointsFor', against: 'pointsAgainst', bound: 16 },   // stdev 18.0
    NFL: { for: 'pointsFor', against: 'pointsAgainst', bound: 10.7 }, // stdev 12.0
    NHL: { for: 'goalsFor', against: 'goalsAgainst', bound: 1.8 },    // stdev 2.0
  };
  if (TOTAL_REVIVAL_FIELDS[league]) {
    const { for: forKey, against: againstKey, bound } = TOTAL_REVIVAL_FIELDS[league];
    const hFor = parseFloat(homeStats[forKey]);
    const hAgainst = parseFloat(homeStats[againstKey]);
    const aFor = parseFloat(awayStats[forKey]);
    const aAgainst = parseFloat(awayStats[againstKey]);
    const tMkt2 = (game.markets.totals || []).find(o => o.outcome === 'Over')
              || (game.markets.totals || []).find(o => o.outcome === 'Under');
    const tLine2 = tMkt2 ? parseFloat(tMkt2.point) : NaN;
    if (isFinite(hFor) && isFinite(hAgainst) && isFinite(aFor) && isFinite(aAgainst) && isFinite(tLine2)) {
      const expTotal2 = (hFor + aFor + hAgainst + aAgainst) / 2;
      const matchupDev2 = expTotal2 - (AVG_TOTAL[league] || tLine2);
      features.sp_pred_total = Math.max(-bound, Math.min(bound, matchupDev2));
      features.sp_edge_total = Math.max(-0.4, Math.min(0.4, totalToOverProb(tLine2 + matchupDev2, tLine2, league) - 0.5));
    }
  }

  // ── Wire sp_prob_home/away, sp_edge_ml_home/away, sp_edge_spread_home/away
  // from real market data (2026-07-07) ────────────────────────────────────
  // These have been hardcoded to 0 since 2026-06-10, when a stale 0.5
  // placeholder was found injecting a constant +1.35 run MLB home tilt
  // through the same weight slots (sp_prob_home=3.0, sp_prob_away=3.0,
  // sp_edge_ml_home=2.6, sp_edge_ml_away=2.6, sp_edge_spread_home/away=3.2
  // for MLB; similar sizes for NBA/NFL/NHL). The fix zeroed them out but
  // nobody wired real data back in — same shape as the totals
  // sp_edge_total/sp_pred_total bug fixed the same day (see above), except
  // that one got revived and these didn't.
  //
  // Important: this is NOT a dedicated sharp-money/Pinnacle feed. The Odds
  // API fetch here uses `regions=us` only — no offshore sharp book is in the
  // mix — so calling this "sharp" would overstate what it is. It's built
  // from two market signals we already collect for every game but don't
  // otherwise feed into pick logic:
  //   sp_prob_home/away: no-vig consensus win probability from the
  //     moneyline market for that side. This is a "regress toward the
  //     market" shrinkage term (tempers overconfidence) — legitimate, but
  //     it's not new information the model doesn't already see via the
  //     edge/threshold gate elsewhere, so treat it as a calibration nudge,
  //     not a discovery signal.
  //   sp_edge_ml_home/away, sp_edge_spread_home/away: R2.1's
  //     best-available-price-vs-consensus gap for that side (price-lib.js,
  //     computed for every game already, previously only used for CLV
  //     logging/line-shopping display). This genuinely is new information —
  //     how much a book is out of line with consensus — not fed into any
  //     pick logic until now.
  // Bounded to keep either signal from overpowering the base model.
  // Contributes 0 when market data for a side is missing.
  // 2026-07-07: starting weights intentionally very low across all leagues
  // (config/model-params.*.json) since this is untested — MLB especially,
  // given current live performance is good and we don't want to disrupt it.
  {
    const h2hMkt = game.markets.h2h || [];
    const spreadMkt = game.markets.spreads || [];

    const homeH2h = h2hMkt.find(o => o.outcome === game.home);
    const awayH2h = h2hMkt.find(o => o.outcome === game.away);
    if (homeH2h && awayH2h) {
      const homeImplied = parseFloat(homeH2h.impliedProb);
      const awayImplied = parseFloat(awayH2h.impliedProb);
      if (isFinite(homeImplied) && isFinite(awayImplied)) {
        const [homeNoVig, awayNoVig] = removeVig(homeImplied, awayImplied);
        features.sp_prob_home = Math.max(0.15, Math.min(0.85, homeNoVig));
        features.sp_prob_away = Math.max(0.15, Math.min(0.85, awayNoVig));
      }
      const homeBest = parseFloat(homeH2h.bestImpliedProb);
      const awayBest = parseFloat(awayH2h.bestImpliedProb);
      if (isFinite(homeImplied) && isFinite(homeBest)) {
        features.sp_edge_ml_home = Math.max(-0.15, Math.min(0.15, homeImplied - homeBest));
      }
      if (isFinite(awayImplied) && isFinite(awayBest)) {
        features.sp_edge_ml_away = Math.max(-0.15, Math.min(0.15, awayImplied - awayBest));
      }
    }

    const homeSpreadOdds = spreadMkt.find(o => o.outcome === game.home);
    const awaySpreadOdds = spreadMkt.find(o => o.outcome === game.away);
    if (homeSpreadOdds) {
      const hi = parseFloat(homeSpreadOdds.impliedProb);
      const hb = parseFloat(homeSpreadOdds.bestImpliedProb);
      if (isFinite(hi) && isFinite(hb)) {
        features.sp_edge_spread_home = Math.max(-0.15, Math.min(0.15, hi - hb));
      }
    }
    if (awaySpreadOdds) {
      const ai = parseFloat(awaySpreadOdds.impliedProb);
      const ab = parseFloat(awaySpreadOdds.bestImpliedProb);
      if (isFinite(ai) && isFinite(ab)) {
        features.sp_edge_spread_away = Math.max(-0.15, Math.min(0.15, ai - ab));
      }
    }
  }

  const mlScore = scoreMarket(features, mlWeights);
  const spreadScore = scoreMarket(features, spreadWeights);
  const totalScore = scoreMarket(features, totalWeights);

  // Blend: base projection + CSV-weighted signal (dampened to prevent overshoot)
  const csvDampen = getTunableFactor('csv_dampen', 0.3); // tunable via param_auto_csv_dampen
  const margin = baseMargin + scoreToMarginAdj(spreadScore, league) * csvDampen + starterAdj;


  // ── Prediction variance: how much do different signals agree? ──
  // Collect win probability estimates from different projection approaches
  const baseWinProb = projectWinProb(baseMargin, league);
  const csvAdjWinProb = projectWinProb(margin, league);
  const mlAdjWinProb = projectWinProb(baseMargin + scoreToMarginAdj(mlScore, league) * csvDampen, league);

  // Variance across: base model, CSV-adjusted model, simple W-L model
  const varianceScore = predictionVariance([baseWinProb, csvAdjWinProb, simpleHomeProb, mlAdjWinProb]);

  // Data completeness scoring (includes injury data availability check)
  const { score: completenessScore, flags: completenessFlags } = dataCompleteness(
    homeStats, awayStats, scheduleInfo, league, game.home, game.away
  );

  // Uncertainty: inverse of data completeness (more data = less uncertainty)
  const baseUncertainty = scoreUncertainty(completenessFlags);
  // Blend prediction variance into uncertainty (15% weight).
  // 2026-06-01: dropped 30%→15%. The variance signal was being corrupted by the
  // CSV sp_edge_total bias (since-fixed) so it was telling us "high variance"
  // when the issue was just the bug. Lighter blend until we've seen 2 weeks of
  // clean variance data.
  const uncertainty = baseUncertainty * 0.85 + varianceScore * 0.15;

  // Parse market odds for this game
  const h2hMarket = game.markets.h2h || [];
  const spreadsMarket = game.markets.spreads || [];
  const totalsMarket = game.markets.totals || [];

  const picks = [];

  // ââ Moneyline Pick ââââââââââââââââââââââââââââââââââââââââ
  // Update SP features with our projections (self-referential signal)
  features.sp_pred_margin = margin / (STRENGTH_TO_MARGIN[league] || 20);

  const mlMargin = baseMargin + scoreToMarginAdj(mlScore, league) * csvDampen + starterAdj;
  const mlPick = generateMLPick(game, mlMargin, league, h2hMarket, uncertainty);
  if (mlPick) {
    const mlMainProb = projectWinProb(mlMargin, league);
    mlPick._disagreement = modelDisagreement(mlMainProb, simpleHomeProb, 'moneyline');
    const mlContribs = decomposeScore(features, mlWeights);
    mlPick._edgeDriver = mlContribs.length > 0 ? mlContribs[0].feature : 'base_model';
    mlPick._topContributions = mlContribs.slice(0, 5);
    picks.push(mlPick);
  }

  // ââ Spread Pick âââââââââââââââââââââââââââââââââââââââââââ
  const spreadPick = generateSpreadPick(game, margin, league, spreadsMarket, uncertainty);
  if (spreadPick) {
    const spreadMainProb = projectWinProb(margin, league);
    spreadPick._disagreement = modelDisagreement(spreadMainProb, simpleHomeProb, 'spread');
    const spContribs = decomposeScore(features, spreadWeights);
    spreadPick._edgeDriver = spContribs.length > 0 ? spContribs[0].feature : 'base_model';
    spreadPick._topContributions = spContribs.slice(0, 5);
    picks.push(spreadPick);
  }

  // ââ Total Pick ââââââââââââââââââââââââââââââââââââââââââââ
  const totalAdj = scoreToTotalAdj(totalScore, league) * csvDampen;
  // Pitcher impact on totals: both good pitchers = lower total, both bad = higher
  // 2026-05-31: bumped AVG_ERA 4.20 -> 4.40 to match current MLB scoring environment.
  // Old 4.20 baseline produced systematic +0.10 run Over bias because most starter
  // ERAs in 2025-26 sit above 4.20. Simulated 70% Over pick rate before this fix.
  let pitcherTotalAdj = 0;
  if (league === 'MLB' && pitcherData) {
    const AVG_ERA = 4.40;
    const homeERA = pitcherData.homePitcher?.era ?? AVG_ERA;
    const awayERA = pitcherData.awayPitcher?.era ?? AVG_ERA;
    // Average ERA deviation × innings factor = total runs adjustment
    const avgDeviation = ((homeERA - AVG_ERA) + (awayERA - AVG_ERA)) / 2;
    pitcherTotalAdj = avgDeviation * (6 / 9); // ~6 innings per starter
    pitcherTotalAdj = Math.max(-1.5, Math.min(1.5, pitcherTotalAdj));
  }
  // NHL goalie impact on totals: two above-average goalies = lower total,
  // two weak goalies = higher. Computed in goalie-data.js (capped ±0.5 goals),
  // scaled by the same conservative goalie_adj_scale factor as the margin adj.
  let goalieTotalAdj = 0;
  if (league === 'NHL' && pitcherData?.goalieTotalAdj) {
    goalieTotalAdj = pitcherData.goalieTotalAdj * goalieScale;
  }
  const weatherAdj = gameWeather?.impact || 0;
  const combinedTotalAdj = totalAdj + pitcherTotalAdj + goalieTotalAdj + weatherAdj;
  const totalPick = generateTotalPick(game, homeStr, awayStr, league, totalsMarket, uncertainty, paceAdj, combinedTotalAdj);
  if (totalPick) {
    totalPick._disagreement = 0; // Simple model has no total projection
    const totContribs = decomposeScore(features, totalWeights);
    totalPick._edgeDriver = totContribs.length > 0 ? totContribs[0].feature : 'base_model';
    totalPick._topContributions = totContribs.slice(0, 5);
    picks.push(totalPick);
  }

  // Attach data completeness and feature vector to all picks
  for (const pick of picks) {
    pick._dataCompleteness = completenessScore;
    pick._variance = varianceScore;
    pick._features = features;
    pick._homeTeam = game.home;
    pick._awayTeam = game.away;
    pick._commence = game.commence || ''; // per-game start time; distinguishes doubleheader Game 1 vs Game 2 downstream
  }

  return picks;
}

/**
 * Generate moneyline pick for a game.
 */
function generateMLPick(game, margin, league, h2hMarket, uncertainty) {
  // Find both sides' odds
  const homeOdds = h2hMarket.find(o => o.outcome === game.home);
  const awayOdds = h2hMarket.find(o => o.outcome === game.away);

  if (!homeOdds && !awayOdds) {
    // No ML odds available â create a minimum pick based on margin direction
    const pickTeam = margin >= 0 ? game.home : game.away;
    return {
      team: pickTeam,
      betType: 'moneyline',
      line: '',
      confidence: 1,
      rationale: `No ML odds available. Model leans ${pickTeam} (projected margin: ${margin.toFixed(1)}).`,
      _modelProb: margin >= 0 ? 0.52 : 0.48,
      _marketImpliedProb: 0.5,
      _edge: 0,
      _units: 0.01,
    };
  }

  // Projected win probabilities
  const homeWinProb = projectWinProb(margin, league);
  const awayWinProb = 1 - homeWinProb;

  // Market implied probs (remove vig for fair comparison)
  const homeImplied = americanToImpliedProb(homeOdds ? homeOdds.price : -110);
  const awayImplied = americanToImpliedProb(awayOdds ? awayOdds.price : -110);
  const [homeNoVig, awayNoVig] = removeVig(homeImplied, awayImplied);

  // Pick the side with more edge (model prob - market no-vig prob)
  const homeEdge = calcEdge(homeWinProb, homeNoVig);
  const awayEdge = calcEdge(awayWinProb, awayNoVig);

  let pickTeam, modelProb, marketProb, odds, bestOdds, edge;
  if (homeEdge > awayEdge) {
    pickTeam = game.home;
    modelProb = homeWinProb;
    marketProb = homeNoVig;
    odds = homeOdds ? homeOdds.price : -110;
    bestOdds = homeOdds ? homeOdds.bestPrice : undefined;
    edge = homeEdge;
  } else {
    pickTeam = game.away;
    modelProb = awayWinProb;
    marketProb = awayNoVig;
    odds = awayOdds ? awayOdds.price : -110;
    bestOdds = awayOdds ? awayOdds.bestPrice : undefined;
    edge = awayEdge;
  }

  const numBooks = h2hMarket.length;
  const mktQuality = scoreMarketQuality(numBooks, 0, numBooks > 0);

  return {
    team: pickTeam,
    betType: 'moneyline',
    line: '',
    confidence: edgeToDisplayConfidence(edge),
    rationale: `Model: ${(modelProb * 100).toFixed(1)}% vs market ${(marketProb * 100).toFixed(1)}% (${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% edge). Projected margin: ${margin >= 0 ? 'Home' : 'Away'} by ${Math.abs(margin).toFixed(1)}.`,
    _modelProb: modelProb,
    _marketImpliedProb: marketProb,
    _edge: edge,
    _units: 0,  // calculated below after heavy-fav cap
    _odds: odds,
    // R2.1 step 2: best-available price for the side we actually picked.
    // Selection above is UNCHANGED (still decided on median-derived edge) --
    // this only affects what gets logged/graded for staked bets.
    _bestOdds: Number.isFinite(bestOdds) ? bestOdds : odds,
    _uncertainty: uncertainty,
    _mktQuality: mktQuality,
  };
}

/**
 * Generate spread pick for a game.
 */
function generateSpreadPick(game, margin, league, spreadsMarket, uncertainty) {
  // Find spread lines for both sides
  const homeLine = spreadsMarket.find(o => o.outcome === game.home);
  const awayLine = spreadsMarket.find(o => o.outcome === game.away);

  // Default spreads if not available
  const DEFAULT_SPREADS = { NHL: -1.5, NBA: -1.5, MLB: -1.5, NFL: -2.5 };

  let pickTeam, spreadNum, odds, bestOdds, modelProb, marketProb;

  if (homeLine && awayLine) {
    const homeSpread = parseFloat(homeLine.point) || 0;
    const awaySpread = parseFloat(awayLine.point) || 0;

    if (league === 'MLB') {
      // ── MLB Run Line: Independent value comparison ──
      //
      // The MLB run line is fixed at -1.5/+1.5, making it fundamentally different
      // from NBA/NFL/NHL spreads that move with the line. Treat the two sides as
      // independent value propositions:
      //
      //   -1.5 (Value play): "Win by 2+". Lower probability, plus-money odds.
      //         Best when model projects a comfortable margin.
      //   +1.5 (Safe play): "Don\'t lose by 2+". Higher probability, minus-money odds.
      //         Best when model projects a close game or underdog win.
      //
      // Use normal CDF with calibrated stdev for more realistic cover probabilities,
      // then compare expected profit from edge (edge * payout multiplier) to pick
      // whichever side offers more value per unit risked.

      // Cover probabilities using normal CDF (better calibrated tails than logistic).
      // 2026-05-31: fixed sign error. The home team covers -1.5 when actual_margin
      // exceeds +1.5, i.e. actual_margin > -homeSpread. Previously this asked the
      // wrong question, returning P(actual > homeSpread) which inflated the
      // favorite's cover probability by ~30 percentage points and produced 100%
      // favorite picks on MLB run lines in simulation.
      const MLB_MARGIN_STDEV = 3.8;

      // P(home margin > -homeSpread) for the -1.5 side
      const homeCoverProb = normalCDF((margin + homeSpread) / MLB_MARGIN_STDEV);
      // P(away margin > -awaySpread) for the +1.5 side
      const awayCoverProb = normalCDF(((-margin) + awaySpread) / MLB_MARGIN_STDEV);

      // Market implied cover probs (remove vig)
      const homeImplied = americanToImpliedProb(homeLine.price);
      const awayImplied = americanToImpliedProb(awayLine.price);
      const [homeNoVig, awayNoVig] = removeVig(homeImplied, awayImplied);

      // Edge: model probability minus market probability
      const homeEdge = homeCoverProb - homeNoVig;
      const awayEdge = awayCoverProb - awayNoVig;

      // Expected profit from edge: edge * (1 + payout_multiplier)
      // This weights the edge by how much it pays when right.
      // -1.5 gets amplified by plus-money payout; +1.5 gets dampened by minus-money.
      const homePayout = homeLine.price > 0 ? homeLine.price / 100 : 100 / Math.abs(homeLine.price);
      const awayPayout = awayLine.price > 0 ? awayLine.price / 100 : 100 / Math.abs(awayLine.price);
      const homeProfit = homeEdge * (1 + homePayout);
      const awayProfit = awayEdge * (1 + awayPayout);

      console.log(`[game-model] MLB run line: ${game.home} ${homeSpread} (cover ${(homeCoverProb*100).toFixed(1)}% vs mkt ${(homeNoVig*100).toFixed(1)}%, edge ${(homeEdge*100).toFixed(1)}%, profit ${(homeProfit*100).toFixed(1)}c, odds ${homeLine.price}) | ${game.away} ${awaySpread} (cover ${(awayCoverProb*100).toFixed(1)}% vs mkt ${(awayNoVig*100).toFixed(1)}%, edge ${(awayEdge*100).toFixed(1)}%, profit ${(awayProfit*100).toFixed(1)}c, odds ${awayLine.price}). Margin: ${margin.toFixed(2)}`);

      if (homeProfit > awayProfit) {
        pickTeam = game.home;
        spreadNum = homeSpread;
        odds = homeLine.price;
        bestOdds = homeLine.bestPrice;
        modelProb = homeCoverProb;
        marketProb = homeNoVig;
      } else {
        pickTeam = game.away;
        spreadNum = awaySpread;
        odds = awayLine.price;
        bestOdds = awayLine.bestPrice;
        modelProb = awayCoverProb;
        marketProb = awayNoVig;
      }

      // Tag which value type was selected
      const isValuePlay = (pickTeam === game.home && homeSpread < 0) || (pickTeam === game.away && awaySpread < 0);
      const valueLabel = isValuePlay ? 'Value (-1.5)' : 'Safe (+1.5)';

      const edge = (modelProb - marketProb) * 100;
      const numBooks = spreadsMarket.length;
      const mktQuality = scoreMarketQuality(numBooks, 0, numBooks > 0);

      return {
        team: pickTeam,
        betType: 'spread',
        line: spreadNum,
        confidence: edgeToDisplayConfidence(edge),
        rationale: `[${valueLabel}] Cover: ${(modelProb * 100).toFixed(1)}% vs market ${(marketProb * 100).toFixed(1)}% (${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% edge). Spread: ${spreadNum}. Projected margin: ${margin.toFixed(1)}.`,
        _modelProb: modelProb,
        _marketImpliedProb: marketProb,
        _edge: edge,
        _units: 0,
        _odds: odds,
        // R2.1 step 2: best-available price for the side we actually picked.
        _bestOdds: Number.isFinite(bestOdds) ? bestOdds : odds,
        _uncertainty: uncertainty,
        _mktQuality: mktQuality,
      };
    }

    // ── Non-MLB: standard edge comparison ──
    const homeCoverProb = marginToSpreadCoverProb(margin, homeSpread, league);
    const awayCoverProb = marginToSpreadCoverProb(-margin, awaySpread, league);

    const homeImplied = americanToImpliedProb(homeLine.price);
    const awayImplied = americanToImpliedProb(awayLine.price);
    const [homeNoVig, awayNoVig] = removeVig(homeImplied, awayImplied);

    const homeEdge = calcEdge(homeCoverProb, homeNoVig);
    const awayEdge = calcEdge(awayCoverProb, awayNoVig);

    if (homeEdge > awayEdge) {
      pickTeam = game.home;
      spreadNum = homeSpread;
      odds = homeLine.price;
      bestOdds = homeLine.bestPrice;
      modelProb = homeCoverProb;
      marketProb = homeNoVig;
    } else {
      pickTeam = game.away;
      spreadNum = awaySpread;
      odds = awayLine.price;
      bestOdds = awayLine.bestPrice;
      modelProb = awayCoverProb;
      marketProb = awayNoVig;
    }
  } else {
    // No spread data — use default, pick the model favorite
    const defaultSpread = DEFAULT_SPREADS[league] || -1.5;
    if (margin >= 0) {
      pickTeam = game.home;
      spreadNum = -Math.abs(defaultSpread);
    } else {
      pickTeam = game.away;
      spreadNum = -Math.abs(defaultSpread);
    }
    odds = -110;
    modelProb = marginToSpreadCoverProb(
      pickTeam === game.home ? margin : -margin,
      spreadNum,
      league
    );
    marketProb = 0.5;
  }

  const edge = calcEdge(modelProb, marketProb);
  const numBooks = spreadsMarket.length;
  const mktQuality = scoreMarketQuality(numBooks, 0, numBooks > 0);

  return {
    team: pickTeam,
    betType: 'spread',
    line: spreadNum,
    confidence: edgeToDisplayConfidence(edge),
    rationale: `Cover prob: ${(modelProb * 100).toFixed(1)}% vs market ${(marketProb * 100).toFixed(1)}% (${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% edge). Spread: ${spreadNum}. Projected margin: ${margin.toFixed(1)}.`,
    _modelProb: modelProb,
    _marketImpliedProb: marketProb,
    _edge: edge,
    _units: 0,
    _odds: odds,
    // R2.1 step 2: best-available price for the side we actually picked.
    // undefined in the no-market-data fallback branch (nothing to shop) --
    // falls back to odds (-110) there.
    _bestOdds: Number.isFinite(bestOdds) ? bestOdds : odds,
    _uncertainty: uncertainty,
    _mktQuality: mktQuality,
  };
}

/**
 * Generate total (over/under) pick for a game.
 * Sprint 2: Now accepts paceAdj from stat-features.
 */
function generateTotalPick(game, homeStr, awayStr, league, totalsMarket, uncertainty, paceAdj, csvTotalAdj) {
  // Diagnostic: log what totalsMarket contains for this game
  console.log(`[generateTotalPick] ${game.away}@${game.home} (${league}): totalsMarket has ${totalsMarket.length} entries: ${JSON.stringify(totalsMarket)}`);

  // Find over and under lines
  const overLine = totalsMarket.find(o => o.outcome === 'Over');
  const underLine = totalsMarket.find(o => o.outcome === 'Under');

  const DEFAULT_TOTALS = { NHL: 6, NBA: 220, MLB: 8.5, NFL: 44.5 };

  let marketTotal, overOdds, underOdds;
  if (overLine) {
    marketTotal = parseFloat(overLine.point) || DEFAULT_TOTALS[league] || 6;
    overOdds = overLine.price;
    underOdds = underLine ? underLine.price : -110;
  } else if (underLine) {
    marketTotal = parseFloat(underLine.point) || DEFAULT_TOTALS[league] || 6;
    overOdds = -110;
    underOdds = underLine.price;
  } else {
    marketTotal = DEFAULT_TOTALS[league] || 6;
    overOdds = -110;
    underOdds = -110;
  }

  // Project the total (now with pace adjustment)
  const baseProjTotal = projectTotal(homeStr, awayStr, marketTotal, league, paceAdj);
  const projTotal = baseProjTotal + (csvTotalAdj || 0);

  // Over/under probabilities
  const overProb = totalToOverProb(projTotal, marketTotal, league);
  const underProb = 1 - overProb;

  // Market implied (remove vig)
  const overImplied = americanToImpliedProb(overOdds);
  const underImplied = americanToImpliedProb(underOdds);
  const [overNoVig, underNoVig] = removeVig(overImplied, underImplied);

  // Pick the side with more edge
  const overEdge = calcEdge(overProb, overNoVig);
  const underEdge = calcEdge(underProb, underNoVig);

  // 2026-05-31: strict > so an exact-tie (e.g., projTotal == marketTotal, both
  // sides equally priced) doesn't deterministically pick Over. With Over rate
  // already biased upward, the >= tiebreaker compounded the lean.
  let direction, modelProb, marketProb, odds, bestOdds, edge;
  if (overEdge > underEdge) {
    direction = 'Over';
    modelProb = overProb;
    marketProb = overNoVig;
    odds = overOdds;
    bestOdds = overLine ? overLine.bestPrice : undefined;
    edge = overEdge;
  } else {
    direction = 'Under';
    modelProb = underProb;
    marketProb = underNoVig;
    odds = underOdds;
    bestOdds = underLine ? underLine.bestPrice : undefined;
    edge = underEdge;
  }

  const numBooks = totalsMarket.length;
  const mktQuality = scoreMarketQuality(numBooks, 0, numBooks > 0);

  return {
    team: `${direction} ${marketTotal}`,
    betType: direction.toLowerCase(),
    line: marketTotal,
    confidence: edgeToDisplayConfidence(edge),
    rationale: `Projected total: ${projTotal.toFixed(1)} vs line ${marketTotal} (${direction}). ${(modelProb * 100).toFixed(1)}% vs market ${(marketProb * 100).toFixed(1)}% (${edge >= 0 ? '+' : ''}${edge.toFixed(1)}% edge).`,
    _modelProb: modelProb,
    _marketImpliedProb: marketProb,
    _edge: edge,
    _units: 0,
    _odds: odds,
    // R2.1 step 2: best-available price for the side we actually picked.
    // undefined when there's no matching over/under book line (default -110
    // fallback case) -- falls back to odds there.
    _bestOdds: Number.isFinite(bestOdds) ? bestOdds : odds,
    _uncertainty: uncertainty,
    _mktQuality: mktQuality,
  };
}

// ââ Main Entry Point âââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate deterministic picks for all games in a league.
 * Drop-in replacement for the GPT-based generate*Predictions functions.
 *
 * Sprint 2: Now passes schedule info through to generateGamePicks,
 * which uses stat-features for enriched team strength calculations.
 *
 * @param {Array} games - From buildGameObjects()
 * @param {Object} teamsMap - { teamName: { wins, losses, pct, offRating, ... } }
 * @param {Object} weights - From parseWeightRows()
 * @param {string} league - 'MLB', 'NBA', 'NHL', 'NFL'
 * @param {Function} getPerformanceModifier - (league, betType) => number
 * @param {Object} [scheduleMap] - Optional: { teamName: { homeDaysOff, awayDaysOff, homeB2B, awayB2B } }
 * @returns {Array} Flat array of pick objects with team, betType, line, confidence, rationale
 */
async function generateAllPicks(games, teamsMap, weights, league, getPerformanceModifier, scheduleMap, weatherMap, pitcherMap) {
  // Load auto-tuned factors from weight sheet (param_auto_* keys)
  if (weights && weights.params) {
    const autoFactors = {};
    for (const [key, val] of Object.entries(weights.params)) {
      if (key.startsWith('param_auto_')) {
        autoFactors[key.replace('param_auto_', '')] = val;
      }
    }
    if (Object.keys(autoFactors).length > 0) {
      setTunableFactors(autoFactors);
    }
  }

  // Load calibration + injury data (graceful fallback if unavailable)
  await loadCalibration();
  await loadInjuryImpact();

  const allPicks = [];

  for (const game of games) {
    // Look up schedule info for this game's teams
    const scheduleInfo = scheduleMap
      ? (scheduleMap[game.home] || scheduleMap[game.away] || null)
      : null;

    // Look up weather for this game
    const gameWeather = weatherMap ? weatherMap.get(`${game.away}@${game.home}`) : null;

    // Look up starting-player data for this game:
    //   MLB → probable pitchers (pitcher-data.js), NHL → starting goalies (goalie-data.js).
    // Both maps are keyed "Away@Home"; other leagues pass null.
    const pitcherData = pitcherMap ? pitcherMap.get(`${game.away}@${game.home}`) : null;

    const picks = generateGamePicks(game, teamsMap, weights, league, scheduleInfo, gameWeather, pitcherData);

    for (const pick of picks) {
      // Calculate final units using the sizing model
      const betTypeNorm = pick.betType === 'over' || pick.betType === 'under'
        ? 'total' : pick.betType;
      const perfMod = getPerformanceModifier(league, betTypeNorm);

      const calMod = getCalibrationMultiplier(Math.max(0, pick._edge));
      let units = calcUnits(
        Math.max(0, pick._edge),
        pick._uncertainty || 0.5,
        pick._mktQuality || 0.5,
        perfMod,
        calMod
      );

      // Apply model disagreement penalty (0-30% reduction)
      const disagreement = pick._disagreement || 0;
      if (disagreement > 0.1) {
        const disagreePenalty = 1.0 - (disagreement * 0.30);
        units *= Math.max(0.50, disagreePenalty);
      }

      // Apply heavy favorite cap for moneyline
      if (pick.betType === 'moneyline' && pick._odds) {
        units = applyHeavyFavCap(pick._odds, units);
      }

      // Absolute floor
      if (!Number.isFinite(units) || units <= 0) units = 0.01;

      pick._units = roundUnits(units); // 2 dp, >= 0.01 (penalty/heavy-fav cap leave long floats)
      pick.confidence = edgeToDisplayConfidence(pick._edge);
      allPicks.push(pick);
    }
  }

  console.log(`[game-model] ${league}: generated ${allPicks.length} deterministic picks for ${games.length} games`);
  return allPicks;
}

module.exports = {
  generateAllPicks,
  generateGamePicks,    // Exported for testing / calibration
  projectMargin,
  projectTotal,
  projectWinProb,
  AVG_TOTAL,
  STRENGTH_TO_MARGIN,
};
