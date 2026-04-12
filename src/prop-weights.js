'use strict';
/**
 * prop-weights.js — Prop Market Weights & Modifiers
 *
 * Parallel to weights.js for main picks, but for player prop markets.
 * Each league has its own PropWeights sheet with market-level modifiers
 * that are auto-adjusted nightly based on CLV performance.
 *
 * Sheet schema (3 columns): market, key, weight
 *   e.g., "batter_hits", "clv_modifier", "1.2"
 *         "pitcher_strikeouts", "clv_modifier", "0.7"
 *
 * The modifier multiplies the raw edge before ranking, so markets that
 * historically beat closing lines get boosted and losers get suppressed.
 */
const { getValues, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

// Default modifier for markets with no historical data yet
const DEFAULT_MODIFIER = 1.0;

// Guardrails: don't let modifiers go too extreme
const MIN_MODIFIER = 0.3;
const MAX_MODIFIER = 1.8;

// Minimum sample size before adjusting weights (need enough data to be meaningful)
const MIN_SAMPLE_SIZE = 15;

/**
 * Pick the right PropWeights sheet for a league.
 */
function propSheetForLeague(league) {
  const L = String(league || '').toUpperCase();
  if (L === 'NBA') return SHEETS.PROP_WEIGHTS_NBA;
  if (L === 'NFL') return SHEETS.PROP_WEIGHTS_NFL;
  if (L === 'NHL') return SHEETS.PROP_WEIGHTS_NHL;
  return SHEETS.PROP_WEIGHTS_MLB;
}

/**
 * Read prop weights for a league.
 * Returns { [marketKey]: { clv_modifier, clv_hit_rate, sample_size, last_updated } }
 */
async function readPropWeights(league) {
  const sheet = propSheetForLeague(league);
  let rows;
  try {
    rows = await getValues(SPREADSHEET_ID, sheet);
  } catch (err) {
    console.warn(`[prop-weights] Could not read ${sheet}: ${err.message}. Using defaults.`);
    return {};
  }
  if (!rows || rows.length < 2) return {};

  const weights = {};
  // Skip header if present
  const startIdx = (rows[0] && /market/i.test(String(rows[0][0] || ''))) ? 1 : 0;
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i] || [];
    const market = String(row[0] || '').trim();
    const key = String(row[1] || '').trim();
    const val = parseFloat(row[2]);
    if (!market || !key || !isFinite(val)) continue;

    if (!weights[market]) weights[market] = {};
    weights[market][key] = val;
  }
  return weights;
}

/**
 * Get the edge modifier for a specific league+market combo.
 * Returns a multiplier (default 1.0) applied to the raw edge.
 */
async function getPropModifier(league, market) {
  const weights = await readPropWeights(league);
  const marketWeights = weights[market] || {};
  return marketWeights.clv_modifier || DEFAULT_MODIFIER;
}

/**
 * Batch version: read all modifiers for a league at once (avoids N API calls).
 * Returns { [market]: modifier }
 */
async function getAllPropModifiers(league) {
  const weights = await readPropWeights(league);
  const modifiers = {};
  for (const [market, vals] of Object.entries(weights)) {
    modifiers[market] = vals.clv_modifier || DEFAULT_MODIFIER;
  }
  return modifiers;
}

/**
 * Write updated prop weights for a league.
 * Called by the nightly auto-update job after CLV grading.
 *
 * @param {string} league
 * @param {Object} updates - { [market]: { clv_modifier, clv_hit_rate, sample_size } }
 */
async function writePropWeights(league, updates) {
  const sheet = propSheetForLeague(league);
  const ts = new Date().toISOString().slice(0, 10);
  const rows = [['market', 'key', 'weight']];

  for (const [market, vals] of Object.entries(updates)) {
    // Clamp modifier within guardrails
    const modifier = Math.max(MIN_MODIFIER, Math.min(MAX_MODIFIER, vals.clv_modifier || DEFAULT_MODIFIER));
    rows.push([market, 'clv_modifier', parseFloat(modifier.toFixed(3))]);
    if (vals.clv_hit_rate !== undefined) {
      rows.push([market, 'clv_hit_rate', parseFloat(vals.clv_hit_rate.toFixed(3))]);
    }
    if (vals.sample_size !== undefined) {
      rows.push([market, 'sample_size', vals.sample_size]);
    }
    rows.push([market, 'last_updated', ts]);
  }

  await setValues(SPREADSHEET_ID, sheet, 'A1', rows);
  console.log(`[prop-weights] Wrote ${Object.keys(updates).length} market weights to ${sheet}`);
}

/**
 * Compute new modifiers based on CLV performance data.
 * Called by the nightly weight update job.
 *
 * Logic:
 *   - CLV hit rate > 55% → boost modifier by 10%
 *   - CLV hit rate 50-55% → hold modifier
 *   - CLV hit rate 45-50% → reduce modifier by 10%
 *   - CLV hit rate < 45% → reduce modifier by 20%
 *   - Sample size < MIN_SAMPLE_SIZE → leave at default (not enough data)
 *
 * @param {Object} currentWeights - current { [market]: { clv_modifier, ... } }
 * @param {Object} clvData - { [market]: { hitRate, sampleSize, avgEdge } }
 * @returns {Object} updated weights
 */
function computeWeightUpdates(currentWeights, clvData) {
  const updates = {};

  for (const [market, metrics] of Object.entries(clvData)) {
    const current = (currentWeights[market] || {}).clv_modifier || DEFAULT_MODIFIER;
    let newModifier = current;

    if (metrics.sampleSize < MIN_SAMPLE_SIZE) {
      // Not enough data — keep current or default
      newModifier = current;
      console.log(`[prop-weights] ${market}: ${metrics.sampleSize} samples (< ${MIN_SAMPLE_SIZE}), holding at ${current}`);
    } else if (metrics.hitRate >= 0.55) {
      // Strong performer — boost
      newModifier = current * 1.10;
      console.log(`[prop-weights] ${market}: ${(metrics.hitRate * 100).toFixed(1)}% hit rate → boost ${current} → ${newModifier.toFixed(3)}`);
    } else if (metrics.hitRate >= 0.50) {
      // Holding — no change
      newModifier = current;
      console.log(`[prop-weights] ${market}: ${(metrics.hitRate * 100).toFixed(1)}% hit rate → hold at ${current}`);
    } else if (metrics.hitRate >= 0.45) {
      // Underperforming — slight cut
      newModifier = current * 0.90;
      console.log(`[prop-weights] ${market}: ${(metrics.hitRate * 100).toFixed(1)}% hit rate → cut ${current} → ${newModifier.toFixed(3)}`);
    } else {
      // Bad — aggressive cut
      newModifier = current * 0.80;
      console.log(`[prop-weights] ${market}: ${(metrics.hitRate * 100).toFixed(1)}% hit rate → hard cut ${current} → ${newModifier.toFixed(3)}`);
    }

    updates[market] = {
      clv_modifier: Math.max(MIN_MODIFIER, Math.min(MAX_MODIFIER, newModifier)),
      clv_hit_rate: metrics.hitRate,
      sample_size: metrics.sampleSize,
    };
  }

  return updates;
}

module.exports = {
  readPropWeights,
  getPropModifier,
  getAllPropModifiers,
  writePropWeights,
  computeWeightUpdates,
  propSheetForLeague,
  DEFAULT_MODIFIER,
  MIN_SAMPLE_SIZE,
};
