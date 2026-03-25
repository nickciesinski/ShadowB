'use strict';
/**
 * weights.js — Weight Optimization
 * Reads/writes the Weights sheet to tune prediction model coefficients.
 */
const { getValues, setValues, getSheetsClient } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

const WEIGHTS_SHEET = SHEETS.WEIGHTS; // 'Weights_MLB' (default)

/**
 * Read all weights from a weights sheet.
 * Returns an object like { recentForm: 0.35, headToHead: 0.25, ... }
 * @param {string} [sheetName] - Override sheet (e.g. SHEETS.WEIGHTS_NBA)
 */
async function readWeights(sheetName) {
  const rows = await getValues(SPREADSHEET_ID, sheetName || WEIGHTS_SHEET);
  const weights = {};
  for (const row of rows) {
    const key = row[0];
    const val = parseFloat(row[1]);
    if (key && !isNaN(val)) {
      weights[key] = val;
    }
  }
  return weights;
}

/**
 * Write updated weights back to a weights sheet.
 * @param {Object} weights - key/value pairs of weight name → numeric value
 * @param {string} [sheetName] - Override sheet (e.g. SHEETS.WEIGHTS_NBA)
 */
async function writeWeights(weights, sheetName) {
  const target = sheetName || WEIGHTS_SHEET;
  const values = Object.entries(weights).map(([k, v]) => [k, v]);
  await setValues(SPREADSHEET_ID, target, 'A1', values);
  console.log('[weights] Wrote', values.length, 'weights to', target);
}

/**
 * Optimize weights by iterating through historical graded bets and
 * finding the coefficient set that maximizes accuracy.
 * This is a simple grid search / hill-climb approach.
 */
async function optimizeWeights() {
  const current = await readWeights();
  console.log('[weights] Current weights:', current);
  // Placeholder: real optimization logic reads Graded Bets, runs predictions,
  // compares outcomes, and adjusts coefficients via hill climbing or gradient descent.
  // Return current weights unchanged until optimization logic is implemented.
  return current;
}

module.exports = { readWeights, writeWeights, optimizeWeights };
