'use strict';
// =============================================================
// src/game-model.js â Deterministic prediction engine
// Replaces GPT-4o in trigger4. For each game, produces picks
// on all 3 markets (moneyline, spread, total) using formula-based
// projections compared against market odds.
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

// ââ League-specific constants ââââââââââââââââââââââââââââââââââââ

/**
 * Home advantage expressed as points/runs/goals added to the home team's
 * projected margin. These are well-established historical averages.
 */
const HOME_ADVANTAGE = {
  NBA: 3.0,    // ~3 points home edge in modern NBA (declining)
  NFL: 2.5,    // ~2.5 points, lower post-COVID
  MLB: 0.35,   // ~0.35 runs, slight home edge
  NHL: 0.25,   // ~0.25 goals home edge
};

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
 * e.g., NBA: a 10% win% gap â 4.0 point expected margin.
 */
const STRENGTH_TO_MARGIN = {
  NBA: 40.0,   // 0.10 win% diff â 4.0 point margin
  NFL: 28.0,   // 0.10 win% diff â 2.8 point margin
  MLB: 8.0,    // 0.10 win% diff â 0.8 run margin
  NHL: 5.0,    // 0.10 win% diff â 0.5 goal margin
};

// ââ Team Strength Model ââââââââââââââââââââââââââââââââââââââââââ

/**
 * Compute a team's strength rating from available stats.
 * Returns a normalized value centered around 0.5.
 *
 * Currently uses win%: simple but available for all 4 sports.
 * Sprint 2 will add offensive/defensive ratings, pace, etc.
 *
 * @param {Object} teamStats - { wins, losses, pct, offRating, defRating, ... }
 * @param {Object} weights - League-specific weights from Weights_* sheet
 * @returns {number} strength 0-1 (0.5 = average)
 */
function teamStrength(teamStats, weights) {
  if (!teamStats) return 0.5;

  // Primary signal: win percentage
  let winPct = parseFloat(teamStats.pct) || 0.5;
  // Clamp extreme values (small sample / bad data)
  winPct = Math.max(0.2, Math.min(0.8, winPct));

  // Weight-based adjustments from the Weights sheet.
  // These weights were previously passed to GPT as context but never
  // actually used in any formula. Now they directly modify the rating.
  let adjustment = 0;

  if (weights) {
    // Offense/defense weights shift the rating if stats are available
    const offWeight = weights.offensive_strength || weights.run_differential_diff || 0;
    const defWeight = weights.defensive_strength || 0;

    // If team has o/d ratings, blend them in
    if (teamStats.offRating && offWeight) {
      // Normalize off rating to 0-centered adjustment (100 = league average for NBA)
      const offAdj = ((parseFloat(teamStats.offRating) || 100) - 100) / 100;
      adjustment += offAdj * offWeight * 0.1;
    }
    if (teamStats.defRating && defWeight) {
      // Lower defensive rating = better. Invert so positive = good.
      const defAdj = (100 - (parseFloat(teamStats.defRating) || 100)) / 100;
      adjustment += defAdj * defWeight * 0.1;
    }
  }

  return Math.max(0.15, Math.min(0.85, winPct + adjustment));
}

/**
 * Compute rest advantage adjustment.
 * More rest = slight advantage; back-to-back = penalty.
 *
 * @param {Object} scheduleInfo - { homeDaysOff, awayDaysOff } if available
 * @param {string} league
 * @returns {number} margin adjustment in points/runs/goals (positive = home advantage)
 */
function restAdjustment(scheduleInfo, league) {
  if (!scheduleInfo) return 0;

  const homeDays = parseFloat(scheduleInfo.homeDaysOff) || 1;
  const awayDays = parseFloat(scheduleInfo.awayDaysOff) || 1;

  // Rest advantage per day difference, scaled by sport
  const REST_IMPACT = { NBA: 0.8, NFL: 0, MLB: 0.1, NHL: 0.5 };
  const impact = REST_IMPACT[league] || 0;

  const restDiff = Math.max(-3, Math.min(3, homeDays - awayDays));
  return restDiff * impact;
}

// ââ Core Projection Functions ââââââââââââââââââââââââââââââââââââ

/**
 * Project the point margin for a game.
 * Positive = home team favored.
 *
 * @param {number} homeStrength - 0-1 rating
 * @param {number} awayStrength - 0-1 rating
 * @param {string} league
 * @param {number} restAdj - rest-based margin adjustment
 * @returns {number} projected margin (home perspective)
 */
function projectMargin(homeStrength, awayStrength, league, restAdj) {
  const strengthDiff = homeStrength - awayStrength;
  const rawMargin = strengthDiff * (STRENGTH_TO_MARGIN[league] || 20);
  const homeAdv = HOME_ADVANTAGE[league] || 0;
  return rawMargin + homeAdv + (restAdj || 0);
}

/**
 * Project the total points/runs/goals for a game.
 * Uses market total as anchor, adjusted by team strength.
 * Stronger teams in high-pace matchups â higher totals.
 *
 * @param {number} homeStrength
 * @param {number} awayStrength
 * @param {number} marketTotal - The market's posted total line
 * @param {string} league
 * @returns {number} projected total
 */
function projectTotal(homeStrength, awayStrength, marketTotal, league) {
  // Use the market total as the primary anchor â it's the best available
  // estimate of the game's expected scoring. We only adjust if our strength
  // model suggests the market is off.
  const avgTotal = AVG_TOTAL[league] || marketTotal;

  // Combined team strength: two strong teams â more scoring (slightly),
  // two weak teams â less scoring. This is a mild adjustment.
  const combinedStrength = (homeStrength + awayStrength) / 2;
  const strengthDeviation = combinedStrength - 0.5; // positive = both strong

  // Total adjustment: scale by league average total to get appropriate magnitude
  // A 5% strength deviation â ~1% total adjustment
  const adjustment = strengthDeviation * avgTotal * 0.04;

  // Anchor heavily to market total (80%), blend in our adjustment (20%).
  // The market is efficient for totals â we're only nudging.
  return marketTotal + adjustment;
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
  // Use the same logistic model as marginToSpreadCoverProb
  // but with spread = 0 (pure win probability)
  return marginToSpreadCoverProb(projectedMargin, 0, league);
}

// ââ Pick Generation ââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate all 3 picks (ML, spread, total) for a single game.
 *
 * @param {Object} game - From buildGameObjects: { home, away, commence, markets }
 * @param {Object} teamsMap - { teamName: { wins, losses, pct, ... } }
 * @param {Object} weights - Parsed weights { flat: {}, moneyline: {}, spread: {}, total: {} }
 * @param {string} league - 'MLB', 'NBA', 'NHL', 'NFL'
 * @param {Object} [scheduleInfo] - Optional: { homeDaysOff, awayDaysOff }
 * @returns {Array} Array of 3 pick objects
 */
function generateGamePicks(game, teamsMap, weights, league, scheduleInfo) {
  const flatWeights = weights.flat || weights || {};

  // Team stats
  const homeStats = teamsMap[game.home] || {};
  const awayStats = teamsMap[game.away] || {};

  // Team strengths
  const homeStr = teamStrength(homeStats, flatWeights);
  const awayStr = teamStrength(awayStats, flatWeights);

  // Rest adjustment
  const restAdj = restAdjustment(scheduleInfo, league);

  // Core projection: margin (home perspective, positive = home favored)
  const margin = projectMargin(homeStr, awayStr, league, restAdj);

  // Data quality flags for uncertainty scoring
  const uncertaintyFlags = {
    hasTeamStats: !!(homeStats.pct && awayStats.pct),
    hasRecentForm: !!(homeStats.recentForm || awayStats.recentForm),
    hasRestData: !!scheduleInfo,
    hasInjuryData: false, // Sprint 4 will populate this
  };
  const uncertainty = scoreUncertainty(uncertaintyFlags);

  // Parse market odds for this game
  const h2hMarket = game.markets.h2h || [];
  const spreadsMarket = game.markets.spreads || [];
  const totalsMarket = game.markets.totals || [];

  const picks = [];

  // ââ Moneyline Pick ââââââââââââââââââââââââââââââââââââââââââââ
  const mlPick = generateMLPick(game, margin, league, h2hMarket, uncertainty);
  if (mlPick) picks.push(mlPick);

  // ââ Spread Pick âââââââââââââââââââââââââââââââââââââââââââââââ
  const spreadPick = generateSpreadPick(game, margin, league, spreadsMarket, uncertainty);
  if (spreadPick) picks.push(spreadPick);

  // ââ Total Pick ââââââââââââââââââââââââââââââââââââââââââââââââ
  const totalPick = generateTotalPick(game, homeStr, awayStr, league, totalsMarket, uncertainty);
  if (totalPick) picks.push(totalPick);

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
    // No ML odds available â create a minimum pick based on margin direction
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
    _units: 0, // calculated below after heavy-fav cap
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

  // Default spreads if not available (common for NHL where puckline isn't always posted)
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
    // No spread data â use default puckline/spread, pick the model favorite
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
 */
function generateTotalPick(game, homeStr, awayStr, league, totalsMarket, uncertainty) {
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
    // No totals data at all â use default
    marketTotal = DEFAULT_TOTALS[league] || 6;
    overOdds = -110;
    underOdds = -110;
  }

  // Project the total
  const projTotal = projectTotal(homeStr, awayStr, marketTotal, league);

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

// ââ Main Entry Point âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate deterministic picks for all games in a league.
 * Drop-in replacement for the GPT-based generate*Predictions functions.
 *
 * @param {Array} games - From buildGameObjects()
 * @param {Object} teamsMap - { teamName: { wins, losses, pct, ... } }
 * @param {Object} weights - From parseWeightRows()
 * @param {string} league - 'MLB', 'NBA', 'NHL', 'NFL'
 * @param {Function} getPerformanceModifier - (league, betType) => number
 * @returns {Array} Flat array of pick objects with team, betType, line, confidence, rationale
 */
function generateAllPicks(games, teamsMap, weights, league, getPerformanceModifier) {
  const allPicks = [];

  for (const game of games) {
    const picks = generateGamePicks(game, teamsMap, weights, league);

    for (const pick of picks) {
      // Calculate final units using the new sizing model
      const betTypeNorm = pick.betType === 'over' || pick.betType === 'under' ? 'total' : pick.betType;
      const perfMod = getPerformanceModifier(league, betTypeNorm);

      let units = calcUnits(
        Math.max(0, pick._edge),
        pick._uncertainty || 0.5,
        pick._mktQuality || 0.5,
        perfMod
      );

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
  generateGamePicks,
  // Exported for testing / calibration
  teamStrength,
  restAdjustment,
  projectMargin,
  projectTotal,
  projectWinProb,
  HOME_ADVANTAGE,
  AVG_TOTAL,
  STRENGTH_TO_MARGIN,
};
