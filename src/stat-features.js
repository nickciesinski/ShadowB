'use strict';
// =============================================================
// src/stat-features.js â Transform raw stats into model inputs
// Sprint 2: April 2026
//
// Consumes enriched team stats from data-collection.js and
// produces normalized features for game-model.js.
// =============================================================

// ── Tunable Factor Overrides ────────────────────────────────
// Set by game-model.js from weight sheet param_auto_* values.
// When null, hardcoded defaults are used (backward compatible).
let _tunableFactors = null;

function setTunableFactors(factors) {
  _tunableFactors = factors;
}

function getTunableFactor(name, defaultVal) {
  if (_tunableFactors && _tunableFactors[name] !== undefined) return _tunableFactors[name];
  return defaultVal;
}

// ââ Team Strength ââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Compute a composite team strength rating (0â1, 0.5 = average).
 *
 * Blends win%, offensive rating, defensive rating, and recent form
 * using sport-specific weights. Falls back gracefully when stats
 * are missing â win% alone still produces a usable rating.
 *
 * @param {Object} stats - Row from Team Stats sheet
 *   { pct, offRating, defRating, recentFormPct, runsPerGame,
 *     runsAllowedPerGame, goalsFor, goalsAgainst, pace, ... }
 * @param {string} league - 'MLB' | 'NBA' | 'NHL' | 'NFL'
 * @returns {number} 0â1 strength rating
 */
function teamStrength(stats, league) {
  if (!stats) return 0.5;

  const winPct = clamp(parseFloat(stats.pct) || 0.5, 0.2, 0.8);

  // League-specific scoring differential signal
  const diffSignal = scoringDifferential(stats, league);

  // Recent form (10-game rolling win%)
  const form = parseFloat(stats.recentFormPct) || winPct;
  const formClamped = clamp(form, 0.15, 0.85);

  // Blend weights: tunable via nightly optimizer (param_auto_strength_blend_*)
  const wWinPct = getTunableFactor('strength_blend_winpct', 0.35);
  const wScoring = getTunableFactor('strength_blend_scoring', 0.40);
  const wForm = getTunableFactor('strength_blend_form', 0.25);

  if (diffSignal !== null) {
    const blended = winPct * wWinPct + diffSignal * wScoring + formClamped * wForm;
    return clamp(blended, 0.15, 0.85);
  }

  // No scoring differential — redistribute scoring weight to winPct + form
  const fallbackWinPct = wWinPct + wScoring * 0.6;
  const fallbackForm = wForm + wScoring * 0.4;
  const blended = winPct * fallbackWinPct + formClamped * fallbackForm;
  return clamp(blended, 0.15, 0.85);
}

/**
 * Convert offensive/defensive stats into a 0â1 scoring differential signal.
 * Returns null if no relevant stats are available.
 */
function scoringDifferential(stats, league) {
  switch (league) {
    case 'NBA': {
      const off = parseFloat(stats.offRating);
      const def = parseFloat(stats.defRating);
      if (!off || !def) return null;
      // NBA ratings centered around 110. Net rating Â±15 is extreme.
      const netRating = off - def;
      return clamp(0.5 + netRating / 30, 0.15, 0.85);
    }
    case 'MLB': {
      const rpg = parseFloat(stats.runsPerGame);
      const rapg = parseFloat(stats.runsAllowedPerGame);
      if (!rpg || !rapg) return null;
      // Run differential per game: Â±2.0 is extreme
      const diff = rpg - rapg;
      return clamp(0.5 + diff / 4.0, 0.15, 0.85);
    }
    case 'NHL': {
      const gf = parseFloat(stats.goalsFor);
      const ga = parseFloat(stats.goalsAgainst);
      if (!gf || !ga) return null;
      // Goal differential per game: Â±1.0 is extreme
      const diff = gf - ga;
      return clamp(0.5 + diff / 2.0, 0.15, 0.85);
    }
    case 'NFL': {
      const pf = parseFloat(stats.pointsFor);
      const pa = parseFloat(stats.pointsAgainst);
      if (!pf || !pa) return null;
      // Point differential per game: Â±10 is extreme
      const diff = pf - pa;
      return clamp(0.5 + diff / 20.0, 0.15, 0.85);
    }
    default:
      return null;
  }
}

// ââ Rest Adjustment ââââââââââââââââââââââââââââââââââââââââââ

/**
 * Calculate margin adjustment based on rest differential.
 * Positive = home advantage from rest.
 *
 * @param {Object} scheduleInfo - { homeDaysOff, awayDaysOff, homeB2B, awayB2B }
 * @param {string} league
 * @returns {number} margin adjustment in points/runs/goals
 */
function restAdjustment(scheduleInfo, league) {
  if (!scheduleInfo) return 0;

  const homeDays = parseFloat(scheduleInfo.homeDaysOff) || 1;
  const awayDays = parseFloat(scheduleInfo.awayDaysOff) || 1;
  const homeB2B = !!scheduleInfo.homeB2B;
  const awayB2B = !!scheduleInfo.awayB2B;

  // Impact per day of rest differential, by sport
  const REST_PER_DAY = { NBA: 0.8, NFL: 0, MLB: 0.1, NHL: 0.5 };
  // Back-to-back penalty (applied to the B2B team)
  const B2B_PENALTY = { NBA: 1.5, NFL: 0, MLB: 0.15, NHL: 0.8 };

  const impact = REST_PER_DAY[league] || 0;
  const b2bPen = B2B_PENALTY[league] || 0;

  let adj = 0;

  // Rest differential (capped at Â±3 days)
  const restDiff = clamp(homeDays - awayDays, -3, 3);
  adj += restDiff * impact;

  // Back-to-back penalty: penalize the B2B team
  if (homeB2B && !awayB2B) adj -= b2bPen;
  if (awayB2B && !homeB2B) adj += b2bPen;

  // Apply tunable rest impact multiplier
  const restMultiplier = getTunableFactor('margin_rest_impact', 1.0);
  return adj * restMultiplier;
}

// ââ Home Advantage âââââââââââââââââââââââââââââââââââââââââââ

/**
 * Baseline home advantage by league in points/runs/goals.
 * These are well-studied historical averages.
 *
 * @param {string} league
 * @returns {number} margin boost for home team
 */
function homeAdvantage(league) {
  const HA = {
    NBA: 3.0,
    NFL: 2.5,
    MLB: 0.35,
    NHL: 0.25,
  };
  const base = HA[league] || 0;
  const multiplier = getTunableFactor('margin_home_advantage', 1.0);
  return base * multiplier;
}

// ââ Recent Form ââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Compute a trend modifier from recent form vs season average.
 * Positive = team is trending up.
 *
 * @param {Object} stats - must have pct and recentFormPct
 * @returns {number} modifier (-0.1 to +0.1)
 */
function recentForm(stats) {
  if (!stats) return 0;
  const seasonPct = parseFloat(stats.pct) || 0.5;
  const formPct = parseFloat(stats.recentFormPct) || seasonPct;
  // Difference between recent and season, capped
  const diff = formPct - seasonPct;
  return clamp(diff, -0.1, 0.1);
}

// ââ Pace Adjustment ââââââââââââââââââââââââââââââââââââââââââ

/**
 * Estimate total adjustment based on pace data.
 * Two fast-paced teams â higher projected total.
 *
 * @param {Object} homeStats - must have pace field
 * @param {Object} awayStats - must have pace field
 * @param {string} league
 * @returns {number} total adjustment in points/runs/goals
 */
function paceAdjustment(homeStats, awayStats, league) {
  if (league !== 'NBA') return 0; // Pace mainly matters for NBA

  const homePace = parseFloat(homeStats?.pace);
  const awayPace = parseFloat(awayStats?.pace);
  if (!homePace || !awayPace) return 0;

  // League average pace ~100 possessions. Each possession above/below
  // average adds roughly 1 point to the total per team.
  const AVG_PACE = 100;
  const combinedDeviation = ((homePace - AVG_PACE) + (awayPace - AVG_PACE)) / 2;

  // Scale: 5 possessions above average â +5 points total
  return combinedDeviation * 1.0;
}

// ââ Data Completeness Scoring ââââââââââââââââââââââââââââââââ

/**
 * Score how much data we have for a game (0â1).
 * Used by game-model to set uncertainty.
 *
 * @param {Object} homeStats
 * @param {Object} awayStats
 * @param {Object} scheduleInfo
 * @returns {Object} { score, flags }
 */
function dataCompleteness(homeStats, awayStats, scheduleInfo) {
  const flags = {
    hasTeamStats: !!(homeStats?.pct && awayStats?.pct),
    hasOffDef: !!(homeStats?.offRating || homeStats?.runsPerGame || homeStats?.goalsFor),
    hasRecentForm: !!(homeStats?.recentFormPct || awayStats?.recentFormPct),
    hasRestData: !!(scheduleInfo?.homeDaysOff),
    hasPace: !!(homeStats?.pace),
    hasInjuryData: false, // Sprint 4
  };

  const weights = {
    hasTeamStats: 0.25,
    hasOffDef: 0.30,
    hasRecentForm: 0.15,
    hasRestData: 0.15,
    hasPace: 0.10,
    hasInjuryData: 0.05,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (flags[key]) score += weight;
  }

  return { score, flags };
}

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââ

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

module.exports = {
  teamStrength,
  scoringDifferential,
  restAdjustment,
  homeAdvantage,
  recentForm,
  paceAdjustment,
  dataCompleteness,
  clamp,
  setTunableFactors,
  getTunableFactor,
};
