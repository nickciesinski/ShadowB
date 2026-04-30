'use strict';
// =============================================================
// src/game-optimizer.js — Nightly game weight auto-tuning
//
// Analyzes recent graded game picks to determine which weight
// factors correlate with wins vs losses, then nudges weights
// ±1-3% per cycle. Bounded and normalized.
//
// Runs nightly in trigger14. The weekly Cowork review stays as
// a human checkpoint — this optimizer makes small conservative
// moves between reviews.
//
// Tunable factors (per league, per market):
//   - strength_blend_winpct     (teamStrength: winPct weight)
//   - strength_blend_scoring    (teamStrength: scoring diff weight)
//   - strength_blend_form       (teamStrength: recent form weight)
//   - margin_home_advantage     (home field points)
//   - margin_form_influence     (recent form → margin multiplier)
//   - margin_rest_impact        (rest differential multiplier)
//   - total_market_anchor       (how much to trust the market total)
//   - total_pace_dampening      (pace signal dampening)
//   - confidence_power          (param_confidence_power)
// =============================================================

const { getValues, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');
const { readWeights, writeWeights, sheetForLeague } = require('./weights');

// Factors we'll optimize and their defaults
const TUNABLE_FACTORS = {
  strength_blend_winpct:   { default: 0.35, min: 0.10, max: 0.60 },
  strength_blend_scoring:  { default: 0.40, min: 0.10, max: 0.60 },
  strength_blend_form:     { default: 0.25, min: 0.05, max: 0.50 },
  margin_home_advantage:   { default: 1.00, min: 0.50, max: 1.50 },  // multiplier on base HA
  margin_form_influence:   { default: 0.50, min: 0.10, max: 1.00 },
  margin_rest_impact:      { default: 1.00, min: 0.30, max: 2.00 },
  total_market_anchor:     { default: 0.80, min: 0.60, max: 0.95 },
  total_pace_dampening:    { default: 0.30, min: 0.05, max: 0.80 },
  confidence_power:        { default: 1.40, min: 0.80, max: 2.50 },
};

/**
 * Read current tunable factor values from a league's weight sheet.
 * Factors are stored as param_auto_* rows in the weights CSV.
 */
async function readTunableFactors(league) {
  const weights = await readWeights(sheetForLeague(league));
  const factors = {};
  for (const [name, config] of Object.entries(TUNABLE_FACTORS)) {
    const key = `param_auto_${name}`;
    factors[name] = weights.params[key] !== undefined
      ? weights.params[key]
      : config.default;
  }
  return factors;
}

/**
 * Analyze recent graded picks and compute which factor adjustments
 * would have improved results.
 *
 * Performance Log columns (0-indexed):
 *   0: date, 1: league, 2: market, 3: away, 4: home,
 *   9: odds, 10: units, 11: confidence, 16: result (W/L/P), 17: unit_return
 */
async function analyzeGamePerformance(league, days = 14) {
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) return null;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // Collect graded picks for this league
  const picks = { moneyline: { wins: [], losses: [] }, spread: { wins: [], losses: [] }, total: { wins: [], losses: [] } };
  let totalW = 0, totalL = 0;

  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 18) continue;

    const pickLeague = (row[1] || '').trim().toUpperCase();
    if (pickLeague !== league) continue;

    const result = (row[16] || '').toString().trim();
    if (result !== 'W' && result !== 'L') continue;

    // Date filter
    const rawDate = String(row[0] || '').trim();
    const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!parts) continue;
    const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (pickDate < cutoff) continue;

    const market = (row[2] || '').trim().toLowerCase();
    if (!picks[market]) continue;

    const odds = parseInt(row[9]) || -110;
    const units = parseFloat(row[10]) || 0;
    const confidence = parseInt(String(row[11] || '').replace('%', '')) || 5;
    const unitReturn = parseFloat(row[17]) || 0;

    const pickData = { odds, units, confidence, unitReturn, market };

    if (result === 'W') {
      picks[market].wins.push(pickData);
      totalW++;
    } else {
      picks[market].losses.push(pickData);
      totalL++;
    }
  }

  return { picks, totalW, totalL, total: totalW + totalL };
}

/**
 * Compute weight nudges based on performance analysis.
 *
 * Strategy:
 * - If spread is outperforming ML → boost strength/form factors (edge detection)
 * - If totals underperforming → adjust pace/anchor weights
 * - Overall: if win rate is high → small boost to confidence_power
 *            if win rate is low → reduce confidence_power to flatten bets
 * - Per-market ROI → adjust the relevant factors
 */
function computeNudges(analysis, currentFactors) {
  if (!analysis || analysis.total < 20) return null;

  const nudges = {};
  const { picks, totalW, totalL } = analysis;
  const overallWinRate = totalW / (totalW + totalL);

  for (const [name] of Object.entries(TUNABLE_FACTORS)) {
    nudges[name] = 1.0; // start neutral
  }

  // ── Overall confidence calibration ──
  // If winning >55%, confidence assignments are conservative → boost power
  // If winning <45%, we're overconfident → reduce power
  if (overallWinRate > 0.55) {
    nudges.confidence_power = 1.02;
  } else if (overallWinRate < 0.45) {
    nudges.confidence_power = 0.98;
  }

  // ── Market-specific analysis ──
  for (const market of ['moneyline', 'spread', 'total']) {
    const w = picks[market].wins.length;
    const l = picks[market].losses.length;
    if (w + l < 5) continue;

    const marketWinRate = w / (w + l);
    const marketROI = (w + l) > 0
      ? [...picks[market].wins, ...picks[market].losses]
          .reduce((sum, p) => sum + p.unitReturn, 0) /
        [...picks[market].wins, ...picks[market].losses]
          .reduce((sum, p) => sum + p.units, 0)
      : 0;

    // Average confidence on wins vs losses
    const avgConfWin = w > 0 ? picks[market].wins.reduce((s, p) => s + p.confidence, 0) / w : 5;
    const avgConfLoss = l > 0 ? picks[market].losses.reduce((s, p) => s + p.confidence, 0) / l : 5;
    const confLift = avgConfWin - avgConfLoss;

    if (market === 'moneyline' || market === 'spread') {
      // ML and spread depend on margin projection accuracy
      if (marketWinRate > 0.55) {
        // Margin projection is working — boost key factors slightly
        nudges.strength_blend_scoring = Math.min(nudges.strength_blend_scoring * 1.01, 1.03);
        nudges.margin_form_influence = Math.min(nudges.margin_form_influence * 1.01, 1.03);
      } else if (marketWinRate < 0.45) {
        // Margin projection is off — lean more toward market consensus
        nudges.strength_blend_scoring = Math.max(nudges.strength_blend_scoring * 0.99, 0.97);
        nudges.margin_form_influence = Math.max(nudges.margin_form_influence * 0.99, 0.97);
      }

      // If recent form on wins differs from losses, adjust form weight
      if (confLift > 1.0) {
        // Higher confidence picks are winning more → form/strength signals are good
        nudges.strength_blend_form = Math.min(nudges.strength_blend_form * 1.02, 1.03);
      } else if (confLift < -1.0) {
        // Lower confidence picks are outperforming → our signals are inverted
        nudges.strength_blend_form = Math.max(nudges.strength_blend_form * 0.98, 0.97);
      }

      // Rest/home advantage
      if (market === 'spread' && marketWinRate > 0.52) {
        nudges.margin_home_advantage = Math.min(nudges.margin_home_advantage * 1.01, 1.03);
        nudges.margin_rest_impact = Math.min(nudges.margin_rest_impact * 1.01, 1.03);
      }
    }

    if (market === 'total') {
      if (marketWinRate > 0.55) {
        // Total projection is accurate — trust our model more vs market
        nudges.total_market_anchor = Math.max(nudges.total_market_anchor * 0.99, 0.97);
        nudges.total_pace_dampening = Math.min(nudges.total_pace_dampening * 1.02, 1.03);
      } else if (marketWinRate < 0.45) {
        // Total projection is off — anchor more to market
        nudges.total_market_anchor = Math.min(nudges.total_market_anchor * 1.01, 1.03);
        nudges.total_pace_dampening = Math.max(nudges.total_pace_dampening * 0.98, 0.97);
      }
    }
  }

  return nudges;
}

/**
 * Apply nudges to current factors, respecting bounds.
 */
function applyNudges(currentFactors, nudges) {
  const updated = { ...currentFactors };
  for (const [name, config] of Object.entries(TUNABLE_FACTORS)) {
    const nudge = nudges[name] || 1.0;
    updated[name] = Math.max(config.min, Math.min(config.max, currentFactors[name] * nudge));
    updated[name] = parseFloat(updated[name].toFixed(4));
  }

  // Normalize the strength blend trio to sum to 1.0
  const blendSum = updated.strength_blend_winpct + updated.strength_blend_scoring + updated.strength_blend_form;
  if (blendSum > 0) {
    updated.strength_blend_winpct = parseFloat((updated.strength_blend_winpct / blendSum).toFixed(4));
    updated.strength_blend_scoring = parseFloat((updated.strength_blend_scoring / blendSum).toFixed(4));
    updated.strength_blend_form = parseFloat((updated.strength_blend_form / blendSum).toFixed(4));
  }

  return updated;
}

/**
 * Write updated factors back to the league's weight sheet.
 * Stored as param_auto_* rows alongside existing weight data.
 */
async function writeTunableFactors(league, factors) {
  const sheetName = sheetForLeague(league);
  const rows = await getValues(SPREADSHEET_ID, sheetName);
  if (!rows || rows.length < 1) return;

  // Build set of existing param_auto keys for in-place update
  const autoKeys = new Set();
  for (let i = 0; i < rows.length; i++) {
    const key = (rows[i][1] || '').trim();
    if (key.startsWith('param_auto_')) {
      autoKeys.add(key);
      const factorName = key.replace('param_auto_', '');
      if (factorName in factors) {
        rows[i][2] = factors[factorName];
      }
    }
  }

  // Append any new auto params that don't exist yet
  for (const [name, value] of Object.entries(factors)) {
    const key = `param_auto_${name}`;
    if (!autoKeys.has(key)) {
      rows.push(['', key, value]);
    }
  }

  await setValues(SPREADSHEET_ID, sheetName, 'A1', rows);
}

/**
 * Main optimizer entry point. Runs for all active leagues.
 * Called nightly by trigger14.
 */
async function optimizeGameWeights() {
  console.log('[game-optimizer] Starting nightly game weight optimization...');

  const results = {};
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    try {
      const analysis = await analyzeGamePerformance(league, 14);
      if (!analysis || analysis.total < 20) {
        console.log(`[game-optimizer] ${league}: ${analysis ? analysis.total : 0} picks in 14 days — need 20+, skipping`);
        continue;
      }

      console.log(`[game-optimizer] ${league}: ${analysis.totalW}W/${analysis.totalL}L (${(analysis.totalW / analysis.total * 100).toFixed(1)}% win rate)`);

      const currentFactors = await readTunableFactors(league);
      const nudges = computeNudges(analysis, currentFactors);

      if (!nudges) {
        console.log(`[game-optimizer] ${league}: insufficient data for nudges`);
        continue;
      }

      const updated = applyNudges(currentFactors, nudges);
      await writeTunableFactors(league, updated);

      // Log changes
      const changes = [];
      for (const [name] of Object.entries(TUNABLE_FACTORS)) {
        const old = currentFactors[name];
        const nw = updated[name];
        if (old !== nw) {
          changes.push(`${name}: ${old} → ${nw}`);
        }
      }

      if (changes.length > 0) {
        console.log(`[game-optimizer] ${league}: ${changes.join(', ')}`);
      } else {
        console.log(`[game-optimizer] ${league}: no changes needed`);
      }

      results[league] = { analysis: { totalW: analysis.totalW, totalL: analysis.totalL }, current: currentFactors, updated };
    } catch (err) {
      console.warn(`[game-optimizer] ${league} failed: ${err.message}`);
    }
  }

  console.log('[game-optimizer] Nightly optimization complete');
  return results;
}

module.exports = {
  optimizeGameWeights,
  optimizeCSVWeights,
  readTunableFactors,
  analyzeGamePerformance,
  computeNudges,
  applyNudges,
  TUNABLE_FACTORS,
};

// ── CSV Weight Decay Optimizer ──────────────────────────────
//
// For each CSV weight (per market), correlate the feature value
// with W/L outcomes across recent graded picks. Weights with
// no correlation decay toward 0; correlated weights get boosted.

const { extractFeatures } = require('./game-features');

/**
 * Optimize individual CSV weights by correlating features with outcomes.
 * Runs per-league, per-market. Nudges ±2% per cycle.
 *
 * Performance Log columns:
 *   0:date, 1:league, 2:market, 3:away, 4:home,
 *   9:odds, 10:units, 16:result(W/L/P), 17:unit_return
 */
async function optimizeCSVWeights() {
  console.log('[game-optimizer] Starting CSV weight optimization...');

  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) return null;

  // Load team stats for feature reconstruction
  const teamStatsCache = {};
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    const sheetKey = `${league}_TEAM_STATS`;
    const sheetName = SHEETS[sheetKey];
    if (!sheetName) continue;
    try {
      const rows = await getValues(SPREADSHEET_ID, sheetName);
      if (rows && rows.length > 1) {
        const map = {};
        for (const row of rows.slice(1)) {
          map[row[2]] = {
            pct: row[6], offRating: row[7] || '', defRating: row[8] || '',
            pace: row[9] || '', runsPerGame: row[10] || '',
            runsAllowedPerGame: row[11] || '', goalsFor: row[12] || '',
            goalsAgainst: row[13] || '', pointsFor: row[14] || '',
            pointsAgainst: row[15] || '', recentFormPct: row[16] || '',
          };
        }
        teamStatsCache[league] = map;
      }
    } catch (e) {
      console.warn(`[game-optimizer] Could not load ${league} team stats: ${e.message}`);
    }
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);

  // For each league+market, collect feature values for W and L picks
  const results = {};
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    const teamsMap = teamStatsCache[league] || {};
    if (Object.keys(teamsMap).length === 0) continue;

    const sheetName = sheetForLeague(league);
    const currentWeights = await readWeights(sheetName);

    let updated = false;
    for (const market of ['moneyline', 'spread', 'total']) {
      const mWeights = currentWeights[market] || {};
      if (Object.keys(mWeights).length === 0) continue;

      // Collect feature values for wins vs losses
      const winFeatures = {};  // featureName → [values]
      const lossFeatures = {};
      let wins = 0, losses = 0;

      for (const key of Object.keys(mWeights)) {
        winFeatures[key] = [];
        lossFeatures[key] = [];
      }

      for (let i = 1; i < perfRows.length; i++) {
        const row = perfRows[i];
        if (!row || row.length < 18) continue;

        const pickLeague = (row[1] || '').trim().toUpperCase();
        if (pickLeague !== league) continue;

        const pickMarket = (row[2] || '').trim().toLowerCase();
        if (pickMarket !== market) continue;

        const result = (row[16] || '').toString().trim();
        if (result !== 'W' && result !== 'L') continue;

        const rawDate = String(row[0] || '').trim();
        const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
        if (!parts) continue;
        const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        if (pickDate < cutoff) continue;

        const awayTeam = (row[3] || '').trim();
        const homeTeam = (row[4] || '').trim();
        const homeStats = teamsMap[homeTeam] || {};
        const awayStats = teamsMap[awayTeam] || {};

        if (!homeStats.pct && !awayStats.pct) continue;

        const features = extractFeatures(homeStats, awayStats, null, league);
        const bucket = result === 'W' ? winFeatures : lossFeatures;

        for (const key of Object.keys(mWeights)) {
          if (features[key] !== undefined && features[key] !== null) {
            bucket[key].push(features[key]);
          }
        }

        if (result === 'W') wins++; else losses++;
      }

      if (wins + losses < 15) continue;

      // For each feature: compare avg value on W vs L
      // Positive lift = feature predicts wins = boost weight
      // Negative lift = feature inversely correlates = may need sign flip or decay
      // Zero lift = noise = decay toward 0
      const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      let anyChange = false;
      for (const [key, weight] of Object.entries(mWeights)) {
        if (key.startsWith('param_') || key.startsWith('score_')) continue;

        const avgW = avg(winFeatures[key] || []);
        const avgL = avg(lossFeatures[key] || []);
        const lift = avgW - avgL;

        let nudge = 1.0;
        if (Math.abs(lift) < 0.005) {
          // Noise: decay toward 0
          nudge = 0.98;
        } else if (lift > 0.01 && weight >= 0) {
          // Positive correlation, positive weight → boost
          nudge = 1.02;
        } else if (lift < -0.01 && weight <= 0) {
          // Negative correlation, negative weight → boost magnitude
          nudge = 1.02;
        } else if (lift > 0.01 && weight < 0) {
          // Positive correlation but negative weight → decay toward 0 (let it flip naturally)
          nudge = 0.97;
        } else if (lift < -0.01 && weight > 0) {
          // Negative correlation but positive weight → decay
          nudge = 0.97;
        }

        const newWeight = parseFloat((weight * nudge).toFixed(4));
        // Clamp: don't let weights explode
        const clamped = Math.max(-3.0, Math.min(3.0, newWeight));

        if (clamped !== weight) {
          mWeights[key] = clamped;
          anyChange = true;
        }
      }

      if (anyChange) {
        updated = true;
        console.log(`[game-optimizer] ${league}/${market}: ${wins}W/${losses}L, weights nudged`);
      }
    }

    if (updated) {
      // Rebuild rows and write back
      const allRows = [['market', 'key', 'weight']];
      // Params first
      for (const [key, val] of Object.entries(currentWeights.params)) {
        allRows.push(['', key, val]);
      }
      // Market weights
      for (const market of ['moneyline', 'spread', 'total']) {
        for (const [key, val] of Object.entries(currentWeights[market] || {})) {
          allRows.push([market, key, val]);
        }
      }
      await setValues(SPREADSHEET_ID, sheetName, 'A1', allRows);
      console.log(`[game-optimizer] ${league}: updated weight sheet`);
      results[league] = true;
    }
  }

  return results;
}
