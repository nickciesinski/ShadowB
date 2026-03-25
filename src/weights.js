'use strict';
/**
 * weights.js — Weight Optimization
 * Reads/writes the Weights sheet to tune prediction model coefficients.
 */
const { getSheet, sheetsApi } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

const WEIGHTS_SHEET = SHEETS.WEIGHTS; // 'Weights'

/**
 * Read all weights from the Weights sheet.
 * Returns an object like { recentForm: 0.35, headToHead: 0.25, ... }
 */
async function readWeights() {
  const rows = await getSheet(WEIGHTS_SHEET);
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
 * Write updated weights back to the Weights sheet.
 * @param {Object} weights - key/value pairs of weight name → numeric value
 */
async function writeWeights(weights) {
  const sheets = await sheetsApi();
  const values = Object.entries(weights).map(([k, v]) => [k, v]);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${WEIGHTS_SHEET}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  console.log('[weights] Wrote', values.length, 'weights to sheet');
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
