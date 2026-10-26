'use strict';
// =============================================================
// src/drift-guard.js — circuit-breaker for split drift
//
// Independent backstop to the optimizer's objective penalty. Reads the
// Performance Log, computes the last-N-day directional splits per league,
// and if a market has drifted past a band WITHOUT realized ROI backing it,
// hard-resets the responsible tunable factor(s) to their safe seed values.
//
// Resets go through game-optimizer.writeTunableFactors, so they are clamped
// to safe bounds and can never touch locked rule-keys. Writes land in
// config/model-params.<LEAGUE>.json (committed by the trigger that runs it).
// =============================================================

const { getValues } = require('./sheets');
const dataStore = require('./data-store');
const { SPREADSHEET_ID, SHEETS } = require('./config');
const { computeSplits, BANDS, breaches } = require('./split-metrics');
const { readTunableFactors, writeTunableFactors } = require('./game-optimizer');
const paramStore = require('./param-store');

// Safe seed values a breached factor is reset to.
const SAFE = {
  total_market_anchor: 0.95,   // anchor hard to market -> kills an Over/Under lean
  total_pace_dampening: 0.30,
  margin_home_advantage: 1.00, // neutral home weighting
};

const MIN_SAMPLE = 15;        // need a real slate before acting
const roiBacks = (m) => m && m.roi != null && m.roi > 0.02;

// 2026-10-26: resetting total_market_anchor alone never fixed a totals lean —
// it was already 0.95 when NBA went 43/43 Over. The real cause was total
// features that pushed EVERY game the same way (a stale league-average
// baseline, placeholders stuck at 0.5). So on a totals breach we also find
// any total feature whose weighted contribution leans the drift's way far
// more than it swings game to game, and zero its total weight. A genuine signal moves both
// ways game to game; one that never does is an offset, not a signal.
// Real signals swing both ways around ~0 (on the 10/19-10/26 NBA slate every
// one had |mean| < 0.2x its game-to-game sd); the offsets had mean > 1.2x sd.
const ONE_SIDED_RATIO = 0.75;   // mean lean >= 0.75x its own game-to-game sd...
const ONE_SIDED_MIN_MEAN = 0.1; // ...and big enough to matter (score units)

/**
 * @param {Array} featureRows  prediction_features rows ({ features: {...} })
 * @param {Object} totalWeights  { feature: weight } for the league's total market
 * @param {number} dir  +1 for an Over drift, -1 for an Under drift
 * @returns {Array<{feature, mean, share, n}>} one-sided culprits, biggest first
 *   (share = fraction of games it pushed the drift's way)
 */
function findOneSidedTotalFeatures(featureRows, totalWeights, dir) {
  const out = [];
  for (const [feature, weight] of Object.entries(totalWeights || {})) {
    if (!isFinite(weight) || weight === 0) continue;
    const cs = [];
    for (const r of featureRows || []) {
      const v = r && r.features ? Number(r.features[feature]) : NaN;
      if (isFinite(v)) cs.push(v * weight);
    }
    const n = cs.length;
    if (n < MIN_SAMPLE) continue;
    const mean = cs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(cs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const share = cs.filter(c => c * dir > 0).length / n;
    // sd 0 = a constant: one-sided by definition if it leans the drift's way.
    const lopsided = sd === 0 ? true : (mean * dir) / sd >= ONE_SIDED_RATIO;
    if (mean * dir >= ONE_SIDED_MIN_MEAN && lopsided) out.push({ feature, mean, share, n });
  }
  return out.sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));
}

/** Zero the given total-market weights in config/model-params.<LEAGUE>.json. */
function zeroTotalWeights(league, features) {
  const drop = new Set(features);
  const rows = paramStore.getRows(league);
  for (const row of rows) if (row[0] === 'total' && drop.has(row[1])) row[2] = 0;
  paramStore.setRows(league, rows);
}

async function readTotalFeatureRows(league, days) {
  const db = require('./db');
  const sb = db.getClient && db.getClient();
  if (!sb) return [];
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const { data, error } = await sb.from('prediction_features')
    .select('features').eq('league', league).in('market', ['over', 'under']).gte('date', since);
  if (error) { console.warn('[drift-guard] prediction_features read failed:', error.message); return []; }
  return data || [];
}

/**
 * @param {number} days   lookback window
 * @param {Array}  perfRowsInput  optional pre-fetched Performance Log rows (for tests)
 * @returns {Object} { LEAGUE: { factor: value, ... }, ... } that were reset
 */
async function runDriftGuard(days = 7, perfRowsInput = null, featureRowsInput = null) {
  const perfRows = perfRowsInput || await dataStore.read('performanceRows');
  const reverted = {};
  const zeroed = {};

  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    const s = computeSplits(perfRows, league, days);
    const changes = {};

    if (s.total.n >= MIN_SAMPLE && breaches(s.total.overPct, BANDS.totalOver) && !roiBacks(s.total)) {
      changes.total_market_anchor = SAFE.total_market_anchor;
      changes.total_pace_dampening = SAFE.total_pace_dampening;
      const dir = s.total.overPct > BANDS.totalOver.hi ? 1 : -1;
      const featureRows = featureRowsInput
        ? featureRowsInput.filter(r => !r.league || r.league === league)
        : await readTotalFeatureRows(league, days);
      const culprits = findOneSidedTotalFeatures(featureRows, paramStore.load(league).total, dir);
      if (culprits.length) {
        zeroTotalWeights(league, culprits.map(c => c.feature));
        zeroed[league] = culprits;
        console.log(`[drift-guard] ${league}: zeroed one-sided total features`,
          culprits.map(c => `${c.feature} (mean ${c.mean.toFixed(2)}, ${Math.round(c.share * 100)}% one way, n=${c.n})`).join(', '));
      }
    }
    for (const mk of ['moneyline', 'spread']) {
      if (s[mk].n >= MIN_SAMPLE && breaches(s[mk].homePct, BANDS.gameHome) && !roiBacks(s[mk])) {
        changes.margin_home_advantage = SAFE.margin_home_advantage;
      }
    }

    if (Object.keys(changes).length > 0) {
      const factors = await readTunableFactors(league);
      await writeTunableFactors(league, { ...factors, ...changes });
      reverted[league] = zeroed[league] ? { ...changes, zeroedTotalFeatures: zeroed[league].map(c => c.feature) } : changes;
      console.log(`[drift-guard] ${league}: drift past band -> reset`, changes,
        `(total n=${s.total.n} over%=${s.total.overPct}, ml n=${s.moneyline.n} home%=${s.moneyline.homePct})`);
    }
  }

  if (Object.keys(reverted).length === 0) console.log('[drift-guard] all markets within bands — no action');
  return reverted;
}

module.exports = { runDriftGuard, SAFE, findOneSidedTotalFeatures };
