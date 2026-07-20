'use strict';
// =============================================================
// src/weights-source.js — read model weights for reporting
//
// Single place that turns the JSON param store
// (config/model-params.<LEAGUE>.json, the runtime source of truth)
// into the legacy [market, key, weight] shape the weekly weight
// analysis report used to read from weights/Weights_<LEAGUE>.csv.
//
// The CSV files were retired (R5.2): runtime never read them and
// the optimizer already persists to the JSON store. This helper
// lets the report keep its exact output shape without the CSVs.
// =============================================================

const fs = require('fs');
const paramStore = require('./param-store');

/**
 * Read a league's weights from the JSON param store, shaped like the
 * old CSV reader: { header, rows: [{ market, key, weight }] }.
 * Returns null if the league's param file does not exist.
 */
function readWeights(league) {
  const fp = paramStore.fileFor(league);
  if (!fs.existsSync(fp)) return null;

  const raw = paramStore.getRows(league); // [['market','key','weight'], ['', key, val], ...]
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const [headerRow, ...rest] = raw;
  const header = headerRow.join(',');
  const rows = rest.map(([market, key, weight]) => ({
    market: (market || '').trim(),
    key: (key || '').trim(),
    weight: typeof weight === 'number' ? weight : parseFloat(weight),
  }));
  return { header, rows };
}

module.exports = { readWeights };
