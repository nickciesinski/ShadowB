'use strict';
// =============================================================
// src/prop-scoring.js — Multi-factor prop edge scoring model
//
// Replaces the single CLV modifier with a 6-factor weighted model:
//   1. edge_size       — magnitude of deviation from consensus
//   2. book_reliability — historical win rate of the offering book
//   3. player_tier     — S/A/B/C/D tier mapped to 0-1 score
//   4. consensus_depth — how many books contributed to the median
//   5. player_history  — recent hit rate for this player+market
//   6. clv_modifier    — does this market type beat closing lines?
//
// Each factor is normalized to 0-1 and multiplied by its weight.
// Weights are per-league, stored in PropWeights_{league} sheets.
// =============================================================

const { getValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

// ── Default Weights (used until optimizer tunes them) ────────

const DEFAULT_WEIGHTS = {
  edge_size:        0.30,
  book_reliability:  0.15,
  player_tier:      0.10,
  consensus_depth:  0.10,
  player_history:   0.20,
  clv_modifier:     0.15,
};

// ── Tier Score Mapping ───────────────────────────────────────

const TIER_SCORES = { S: 1.0, A: 0.8, B: 0.6, C: 0.4, D: 0.2 };

// ── Feature Extractors ──────────────────────────────────────

/**
 * Normalize edge size to 0-1 score.
 * 0% edge → 0, 3% edge → 0.5, 6%+ edge → 1.0
 */
function scoreEdgeSize(edgeNum) {
  const abs = Math.abs(edgeNum);
  return Math.min(1.0, abs / 6.0);
}

/**
 * Score book reliability based on historical win rate.
 * @param {string} book - Bookmaker name
 * @param {Object} bookStats - { book: { wins, losses, total } }
 * @returns {number} 0-1 score (0.5 = no data / break-even)
 */
function scoreBookReliability(book, bookStats) {
  const stats = bookStats[(book || '').toLowerCase()];
  if (!stats || stats.total < 10) return 0.5; // neutral until enough data
  const winRate = stats.wins / stats.total;
  // Map 40-60% win rate to 0-1 (below 40% = 0, above 60% = 1)
  return Math.max(0, Math.min(1.0, (winRate - 0.40) / 0.20));
}

/**
 * Score player tier (S=1.0, A=0.8, B=0.6, C=0.4, D=0.2).
 * Higher-tier players have more predictable stat lines.
 */
function scorePlayerTier(tier) {
  return TIER_SCORES[tier] || 0.5;
}

/**
 * Score consensus depth — more books = more reliable median.
 * 2 books → 0.2, 5 books → 0.5, 10+ books → 1.0
 */
function scoreConsensusDepth(numBooks) {
  return Math.min(1.0, (numBooks || 1) / 10);
}

/**
 * Score player history — hit rate for this player+market in recent games.
 * Uses 1/3/5/10 game windows, weighted toward recent.
 * @param {Object} history - { last1: {hit,total}, last3: {...}, last5: {...}, last10: {...} }
 * @returns {number} 0-1 score (0.5 = no data)
 */
function scorePlayerHistory(history) {
  if (!history || history.last10.total === 0) return 0.5; // no data

  // Weighted average: recent games matter more
  const windows = [
    { data: history.last1,  weight: 0.10 },
    { data: history.last3,  weight: 0.25 },
    { data: history.last5,  weight: 0.35 },
    { data: history.last10, weight: 0.30 },
  ];

  let weightedSum = 0;
  let totalWeight = 0;
  for (const { data, weight } of windows) {
    if (data.total > 0) {
      weightedSum += (data.hit / data.total) * weight;
      totalWeight += weight;
    }
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}

/**
 * Score CLV modifier — already a multiplier from prop-weights.js.
 * Normalize: 0.3 → 0, 1.0 → 0.5, 1.8 → 1.0
 */
function scoreClvModifier(modifier) {
  return Math.max(0, Math.min(1.0, (modifier - 0.3) / 1.5));
}

// ── Player History Builder ──────────────────────────────────

/**
 * Build player history lookup from Prop_Performance sheet.
 * Returns: { "LEAGUE|player|market|direction": { last1: {hit,total}, last3, last5, last10 } }
 *
 * Prop_Performance columns:
 *   0=Timestamp, 1=League, 2=Player, 3=Market, 4=Line, 5=Direction,
 *   6=Book, 7=Edge, 8=Actual, 9=Result, 10=AdjustedEdge, 11=Confidence, 12=Units
 */
async function buildPlayerHistory() {
  let perfRows;
  try {
    perfRows = await getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE);
  } catch (e) {
    console.warn(`[prop-scoring] Could not read Prop_Performance: ${e.message}`);
    return {};
  }

  if (!perfRows || perfRows.length < 2) return {};

  // Group results by player+market+direction, most recent first
  const grouped = {}; // key → [{result, timestamp}]
  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 10) continue;

    const result = (row[9] || '').toString().trim().toUpperCase();
    // Only count actual W/L results (not CLV HIT/MISS or UNMATCHED)
    if (result !== 'W' && result !== 'L') continue;

    const league = (row[1] || '').trim();
    const player = (row[2] || '').trim().toLowerCase();
    const market = (row[3] || '').trim();
    const direction = (row[5] || '').trim();
    const timestamp = row[0] || '';

    const key = `${league}|${player}|${market}|${direction}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ result, timestamp });
  }

  // Sort each group by timestamp descending and compute windows
  const history = {};
  for (const [key, entries] of Object.entries(grouped)) {
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const windows = [1, 3, 5, 10];
    const result = {};
    for (const n of windows) {
      const slice = entries.slice(0, n);
      result[`last${n}`] = {
        hit: slice.filter(e => e.result === 'W').length,
        total: slice.length,
      };
    }
    history[key] = result;
  }

  console.log(`[prop-scoring] Built player history: ${Object.keys(history).length} player+market combos`);
  return history;
}

// ── Book Reliability Builder ────────────────────────────────

/**
 * Build book reliability stats from Prop_Performance.
 * Returns: { "bookname": { wins, losses, total } }
 */
async function buildBookStats() {
  let perfRows;
  try {
    perfRows = await getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE);
  } catch (e) {
    console.warn(`[prop-scoring] Could not read Prop_Performance: ${e.message}`);
    return {};
  }

  if (!perfRows || perfRows.length < 2) return {};

  const stats = {};
  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 10) continue;

    const result = (row[9] || '').toString().trim().toUpperCase();
    if (result !== 'W' && result !== 'L') continue;

    const book = (row[6] || '').trim().toLowerCase();
    if (!book) continue;

    if (!stats[book]) stats[book] = { wins: 0, losses: 0, total: 0 };
    stats[book].total++;
    if (result === 'W') stats[book].wins++;
    else stats[book].losses++;
  }

  console.log(`[prop-scoring] Built book stats: ${Object.keys(stats).length} books tracked`);
  return stats;
}

// ── Score an Edge ───────────────────────────────────────────

/**
 * Score a single prop edge using all 6 factors.
 *
 * @param {Object} edge - The edge object from props.js
 * @param {Object} context - { bookStats, playerHistory, tierMap, weights }
 * @returns {Object} - { score, confidence, units, factors }
 */
function scoreEdge(edge, context) {
  const { bookStats, playerHistory, tierMap, weights } = context;
  const w = weights || DEFAULT_WEIGHTS;

  // 1. Edge size
  const f_edge = scoreEdgeSize(edge.edgeNum);

  // 2. Book reliability
  const f_book = scoreBookReliability(edge.book, bookStats);

  // 3. Player tier
  const playerKey = (edge.player || '').trim().toLowerCase();
  const tier = tierMap[playerKey] || 'C';
  const f_tier = scorePlayerTier(tier);

  // 4. Consensus depth (number of books that had this prop)
  const f_depth = scoreConsensusDepth(edge.numBooks || 3);

  // 5. Player history
  const historyKey = `${edge.league}|${playerKey}|${edge.market}|${edge.direction}`;
  const history = playerHistory[historyKey] || null;
  const f_history = scorePlayerHistory(history);

  // 6. CLV modifier (from existing prop-weights system)
  const clvMod = edge.weightModifier || 1.0;
  const f_clv = scoreClvModifier(clvMod);

  // Weighted sum → raw score (0-1)
  const rawScore =
    f_edge    * w.edge_size +
    f_book    * w.book_reliability +
    f_tier    * w.player_tier +
    f_depth   * w.consensus_depth +
    f_history * w.player_history +
    f_clv     * w.clv_modifier;

  // Map raw score (0-1) to confidence (1-10)
  const confidence = Math.max(1, Math.min(10, Math.round(rawScore * 12)));

  // Factor breakdown for logging/analysis
  const factors = {
    edge_size: { value: f_edge, weight: w.edge_size, contrib: f_edge * w.edge_size },
    book_reliability: { value: f_book, weight: w.book_reliability, contrib: f_book * w.book_reliability },
    player_tier: { value: f_tier, weight: w.player_tier, contrib: f_tier * w.player_tier },
    consensus_depth: { value: f_depth, weight: w.consensus_depth, contrib: f_depth * w.consensus_depth },
    player_history: { value: f_history, weight: w.player_history, contrib: f_history * w.player_history },
    clv_modifier: { value: f_clv, weight: w.clv_modifier, contrib: f_clv * w.clv_modifier },
  };

  return { rawScore, confidence, factors };
}

// ── Weight I/O ──────────────────────────────────────────────

/**
 * Read prop scoring weights for a league from its PropWeights sheet.
 * Falls back to DEFAULT_WEIGHTS if no scoring weights found.
 */
async function readScoringWeights(league) {
  try {
    const sheetName = SHEETS[`PROP_WEIGHTS_${league}`] || `PropWeights_${league}`;
    const rows = await getValues(SPREADSHEET_ID, sheetName);
    if (!rows || rows.length < 2) return { ...DEFAULT_WEIGHTS };

    const weights = { ...DEFAULT_WEIGHTS };
    for (const row of rows.slice(1)) {
      const key = (row[1] || '').trim();
      const val = parseFloat(row[2]);
      if (key.startsWith('score_') && !isNaN(val)) {
        const factor = key.replace('score_', '');
        if (factor in weights) {
          weights[factor] = val;
        }
      }
    }
    return weights;
  } catch (e) {
    return { ...DEFAULT_WEIGHTS };
  }
}

/**
 * Read player tier map from Player Tiers sheet.
 * Returns: { "playername": "S"|"A"|"B"|"C"|"D" }
 */
async function buildTierMap() {
  try {
    const rows = await getValues(SPREADSHEET_ID, SHEETS.PLAYER_TIERS);
    if (!rows || rows.length < 2) return {};

    const map = {};
    for (const row of rows.slice(1)) {
      const name = (row[0] || '').trim().toLowerCase();
      const tier = (row[4] || row[3] || 'C').trim();
      if (name) map[name] = tier;
    }
    console.log(`[prop-scoring] Loaded ${Object.keys(map).length} player tiers`);
    return map;
  } catch (e) {
    console.warn(`[prop-scoring] Could not load player tiers: ${e.message}`);
    return {};
  }
}

// ── Main: Load Context + Score All Edges ────────────────────

/**
 * Load all scoring context (player history, book stats, tiers, weights).
 * Call once per trigger run, then pass to scoreEdge() for each edge.
 */
async function loadScoringContext(league) {
  const [bookStats, playerHistory, tierMap, weights] = await Promise.all([
    buildBookStats(),
    buildPlayerHistory(),
    buildTierMap(),
    readScoringWeights(league),
  ]);

  return { bookStats, playerHistory, tierMap, weights };
}

module.exports = {
  // Main API
  scoreEdge,
  loadScoringContext,
  buildPlayerHistory,
  buildBookStats,
  buildTierMap,
  readScoringWeights,

  // Feature scorers (exported for optimizer)
  scoreEdgeSize,
  scoreBookReliability,
  scorePlayerTier,
  scoreConsensusDepth,
  scorePlayerHistory,
  scoreClvModifier,

  // Constants
  DEFAULT_WEIGHTS,
  TIER_SCORES,
};
