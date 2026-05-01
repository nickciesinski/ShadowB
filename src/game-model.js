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

  // Anchor heavily to market total (80%), blend in our adjustment (20%).
  const anchor = getTunableFactor('total_market_anchor', 0.80);
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
function generateGamePicks(game, teamsMap, weights, league, scheduleInfo) {
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

  // CSV-weighted adjustment: if weights exist for moneyline/spread, blend in
  const mlWeights = (weights && weights.moneyline) || {};
  const spreadWeights = (weights && weights.spread) || {};
  const totalWeights = (weights && weights.total) || {};

  const mlScore = scoreMarket(features, mlWeights);
  const spreadScore = scoreMarket(features, spreadWeights);
  const totalScore = scoreMarket(features, totalWeights);

  // Blend: base projection + CSV-weighted signal (dampened to prevent overshoot)
  const csvDampen = 0.3; // 30% influence from CSV weights, grows as optimizer tunes
  const margin = baseMargin + scoreToMarginAdj(spreadScore, league) * csvDampen;


  // ── Prediction variance: how much do different signals agree? ──
  // Collect win probability estimates from different projection approaches
  const baseWinProb = projectWinProb(baseMargin, league);
  const csvAdjWinProb = projectWinProb(margin, league);
  const mlAdjWinProb = projectWinProb(baseMargin + scoreToMarginAdj(mlScore, league) * csvDampen, league);

  // Variance across: base model, CSV-adjusted model, simple W-L model
  const varianceScore = predictionVariance([baseWinProb, csvAdjWinProb, simpleHomeProb, mlAdjWinProb]);

  // Data completeness scoring (replaces manual flag checks)
  const { score: completenessScore, flags: completenessFlags } = dataCompleteness(
    homeStats, awayStats, scheduleInfo
  );

  // Uncertainty: inverse of data completeness (more data = less uncertainty)
  const baseUncertainty = scoreUncertainty(completenessFlags);
  // Blend prediction variance into uncertainty (30% weight)
  const uncertainty = baseUncertainty * 0.7 + varianceScore * 0.3;

  // Parse market odds for this game
  const h2hMarket = game.markets.h2h || [];
  const spreadsMarket = game.markets.spreads || [];
  const totalsMarket = game.markets.totals || [];

  const picks = [];

  // ââ Moneyline Pick ââââââââââââââââââââââââââââââââââââââââ
  // Update SP features with our projections (self-referential signal)
  features.sp_pred_margin = margin / (STRENGTH_TO_MARGIN[league] || 20);

  const mlMargin = baseMargin + scoreToMarginAdj(mlScore, league) * csvDampen;
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
  const totalPick = generateTotalPick(game, homeStr, awayStr, league, totalsMarket, uncertainty, paceAdj, totalAdj);
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

  let pickTeam, modelProb, marketProb, odds, edge;
  if (homeEdge >= awayEdge) {
    pickTeam = game.home;
    modelProb = homeWinProb;
    marketProb = homeNoVig;
    odds = homeOdds ? homeOdds.price : -110;
    edge = homeEdge;
  } else {
    pickTeam = game.away;
    modelProb = awayWinProb;
    marketProb = awayNoVig;
    odds = awayOdds ? awayOdds.price : -110;
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

  let pickTeam, spreadNum, odds, modelProb, marketProb;

  if (homeLine && awayLine) {
    const homeSpread = parseFloat(homeLine.point) || 0;
    const awaySpread = parseFloat(awayLine.point) || 0;

    // Cover probabilities: how likely each side covers their spread
    const homeCoverProb = marginToSpreadCoverProb(margin, homeSpread, league);
    const awayCoverProb = marginToSpreadCoverProb(-margin, awaySpread, league);

    // Market implied cover probs (remove vig)
    const homeImplied = americanToImpliedProb(homeLine.price);
    const awayImplied = americanToImpliedProb(awayLine.price);
    const [homeNoVig, awayNoVig] = removeVig(homeImplied, awayImplied);

    const homeEdge = calcEdge(homeCoverProb, homeNoVig);
    const awayEdge = calcEdge(awayCoverProb, awayNoVig);

    if (homeEdge >= awayEdge) {
      pickTeam = game.home;
      spreadNum = homeSpread;
      odds = homeLine.price;
      modelProb = homeCoverProb;
      marketProb = homeNoVig;
    } else {
      pickTeam = game.away;
      spreadNum = awaySpread;
      odds = awayLine.price;
      modelProb = awayCoverProb;
      marketProb = awayNoVig;
    }
  } else {
    // No spread data â use default, pick the model favorite
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
    _uncertainty: uncertainty,
    _mktQuality: mktQuality,
  };
}

/**
 * Generate total (over/under) pick for a game.
 * Sprint 2: Now accepts paceAdj from stat-features.
 */
function generateTotalPick(game, homeStr, awayStr, league, totalsMarket, uncertainty, paceAdj, csvTotalAdj) {
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

  let direction, modelProb, marketProb, odds, edge;
  if (overEdge >= underEdge) {
    direction = 'Over';
    modelProb = overProb;
    marketProb = overNoVig;
    odds = overOdds;
    edge = overEdge;
  } else {
    direction = 'Under';
    modelProb = underProb;
    marketProb = underNoVig;
    odds = underOdds;
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
async function generateAllPicks(games, teamsMap, weights, league, getPerformanceModifier, scheduleMap) {
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

    const picks = generateGamePicks(game, teamsMap, weights, league, scheduleInfo);

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

      pick._units = units;
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
