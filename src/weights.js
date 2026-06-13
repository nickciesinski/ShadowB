'use strict';
/**
 * weights.js — Weight access layer
 *
 * 2026-06-13: Storage moved OFF the Google Sheet onto file-backed
 * config/model-params.<LEAGUE>.json (see src/param-store.js). The Sheet
 * is no longer in the config read/write path, so the optimizer can no
 * longer clobber hand-set values and there is no Sheet round-trip.
 *
 * Structured shape returned by readWeights():
 *   { params:{...}, moneyline:{...}, spread:{...}, total:{...}, flat:{...} }
 */
const paramStore = require('./param-store');
const { SHEETS } = require('./config');

const WEIGHTS_SHEET = SHEETS.WEIGHTS; // default Weights_MLB (kept for back-compat callers)

/**
 * Parse raw [market, key, weight] rows into a structured object.
 * Still used to parse rows handed back by param-store and any CSV import.
 */
function parseWeightRows(rows) {
  const out = { params: {}, moneyline: {}, spread: {}, total: {}, flat: {} };
  if (!rows || !rows.length) return out;
  const startIdx = (rows[0] && /market/i.test(String(rows[0][0] || '')) && /key/i.test(String(rows[0][1] || ''))) ? 1 : 0;
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i] || [];
    const market = String(row[0] || '').trim().toLowerCase();
    const key = String(row[1] || '').trim();
    const val = parseFloat(row[2]);
    if (!key || !isFinite(val)) continue;
    if (key.startsWith('param_')) {
      out.params[key] = val;
    } else if (market === 'moneyline' || market === 'spread' || market === 'total') {
      out[market][key] = val;
    }
    out.flat[key] = val;
  }
  return out;
}

/**
 * Read and parse params/weights for a league (or a legacy sheet name).
 * Now reads from config/model-params.*.json instead of the Sheet.
 */
async function readWeights(sheetName) {
  const rows = paramStore.getRows(sheetName || WEIGHTS_SHEET);
  return parseWeightRows(rows);
}

/** Backward-compat: return just the flat {key: value} map. */
async function readWeightsFlat(sheetName) {
  const parsed = await readWeights(sheetName);
  return parsed.flat;
}

/** Pick the right param file/league for a league code (kept for callers). */
function sheetForLeague(league) {
  const L = String(league || '').toUpperCase();
  if (L === 'NBA') return SHEETS.WEIGHTS_NBA;
  if (L === 'NFL') return SHEETS.WEIGHTS_NFL;
  if (L === 'NHL') return SHEETS.WEIGHTS_NHL;
  return SHEETS.WEIGHTS_MLB;
}

/**
 * Write [market, key, weight] rows back to a league's param file.
 * (Sheet write removed.)
 */
async function writeWeights(rows, sheetName) {
  const target = sheetName || WEIGHTS_SHEET;
  paramStore.setRows(target, [['market', 'key', 'weight'], ...rows]);
  console.log('[weights] Wrote', rows.length, 'weights to', paramStore.fileFor(target));
}

async function optimizeWeights() {
  const current = await readWeights();
  console.log('[weights] Current params:', current.params);
  return current;
}

module.exports = {
  parseWeightRows,
  readWeights,
  readWeightsFlat,
  sheetForLeague,
  writeWeights,
  optimizeWeights,
};
