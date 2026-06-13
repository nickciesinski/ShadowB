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
const { SPREADSHEET_ID, SHEETS } = require('./config');
const { computeSplits, BANDS, breaches } = require('./split-metrics');
const { readTunableFactors, writeTunableFactors } = require('./game-optimizer');

// Safe seed values a breached factor is reset to.
const SAFE = {
  total_market_anchor: 0.95,   // anchor hard to market -> kills an Over/Under lean
  total_pace_dampening: 0.30,
  margin_home_advantage: 1.00, // neutral home weighting
};

const MIN_SAMPLE = 15;        // need a real slate before acting
const roiBacks = (m) => m && m.roi != null && m.roi > 0.02;

/**
 * @param {number} days   lookback window
 * @param {Array}  perfRowsInput  optional pre-fetched Performance Log rows (for tests)
 * @returns {Object} { LEAGUE: { factor: value, ... }, ... } that were reset
 */
async function runDriftGuard(days = 7, perfRowsInput = null) {
  const perfRows = perfRowsInput || await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  const reverted = {};

  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    const s = computeSplits(perfRows, league, days);
    const changes = {};

    if (s.total.n >= MIN_SAMPLE && breaches(s.total.overPct, BANDS.totalOver) && !roiBacks(s.total)) {
      changes.total_market_anchor = SAFE.total_market_anchor;
      changes.total_pace_dampening = SAFE.total_pace_dampening;
    }
    for (const mk of ['moneyline', 'spread']) {
      if (s[mk].n >= MIN_SAMPLE && breaches(s[mk].homePct, BANDS.gameHome) && !roiBacks(s[mk])) {
        changes.margin_home_advantage = SAFE.margin_home_advantage;
      }
    }

    if (Object.keys(changes).length > 0) {
      const factors = await readTunableFactors(league);
      await writeTunableFactors(league, { ...factors, ...changes });
      reverted[league] = changes;
      console.log(`[drift-guard] ${league}: drift past band -> reset`, changes,
        `(total n=${s.total.n} over%=${s.total.overPct}, ml n=${s.moneyline.n} home%=${s.moneyline.homePct})`);
    }
  }

  if (Object.keys(reverted).length === 0) console.log('[drift-guard] all markets within bands — no action');
  return reverted;
}

module.exports = { runDriftGuard, SAFE };
