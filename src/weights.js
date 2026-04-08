'use strict';
/**
 * weights.js — Weight Optimization
 * Reads/writes the Weights sheet to tune prediction model coefficients.
 *
 * Weights sheet schema (3 columns):
 *   A: market   (empty for param_* rows, or "moneyline"/"spread"/"total")
 *   B: key      (e.g. "param_min_confidence_to_bet" or "run_differential_diff")
 *   C: weight   (numeric)
 *
 * parseWeightRows produces:
 *   {
 *     params:    { param_min_confidence_to_bet: 0.60, ... },
 *     moneyline: { run_differential_diff: 0.85, ... },
 *     spread:    { ... },
 *     total:     { ... },
 *     flat:      { <key>: <value>, ... }   // backward-compat flat merge
 *   }
 */
const { getValues, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

const WEIGHTS_SHEET = SHEETS.WEIGHTS; // default Weights_MLB

/**
 * Parse raw weight rows (including header) into a structured object.
 * Accepts rows where row[0]=market, row[1]=key, row[2]=weight.
 */
function parseWeightRows(rows) {
  const out = { params: {}, moneyline: {}, spread: {}, total: {}, flat: {} };
  if (!rows || !rows.length) return out;
  // Skip header row if first row is header-like
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
    // flat merge: last write wins — useful for GPT prompt context
    out.flat[key] = val;
  }
  return out;
}

/**
 * Read and parse weights from a weights sheet.
 * @param {string} [sheetName] - e.g. SHEETS.WEIGHTS_NBA
 * @returns {Promise<{params:Object, moneyline:Object, spread:Object, total:Object, flat:Object}>}
 */
async function readWeights(sheetName) {
  const rows = await getValues(SPREADSHEET_ID, sheetName || WEIGHTS_SHEET);
  return parseWeightRows(rows);
}

/**
 * Backward-compat: return just the flat {key: value} map.
 * @param {string} [sheetName]
 */
async function readWeightsFlat(sheetName) {
  const parsed = await readWeights(sheetName);
  return parsed.flat;
}

/**
 * Pick the right weights sheet for a league code.
 */
function sheetForLeague(league) {
  const L = String(league || '').toUpperCase();
  if (L === 'NBA') return SHEETS.WEIGHTS_NBA;
  if (L === 'NFL') return SHEETS.WEIGHTS_NFL;
  if (L === 'NHL') return SHEETS.WEIGHTS_NHL;
  return SHEETS.WEIGHTS_MLB;
}

/**
 * Write updated weights back to a weights sheet. Preserves the 3-col schema.
 * @param {Array<[string,string,number]>} rows - [market, key, value] tuples
 * @param {string} [sheetName]
 */
async function writeWeights(rows, sheetName) {
  const target = sheetName || WEIGHTS_SHEET;
  await setValues(SPREADSHEET_ID, target, 'A1',
    [['market', 'key', 'weight'], ...rows]);
  console.log('[weights] Wrote', rows.length, 'weights to', target);
}

/**
 * Placeholder for future hill-climb optimization.
 * The offline optimizer lives in scripts/offline-optimize.js and runs
 * against an exported Performance Log rather than live Sheets.
 */
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
