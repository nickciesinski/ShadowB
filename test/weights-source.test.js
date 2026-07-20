'use strict';
// R5.2: legacy weights/Weights_*.csv files were retired. The weekly weight
// analysis report now reads coefficients from the JSON param store
// (config/model-params.<LEAGUE>.json, the runtime source of truth) via
// src/weights-source.js. These tests pin that reader's shape so the report
// output is unchanged and no CSV dependency creeps back in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readWeights } = require('../src/weights-source');

test('readWeights returns the CSV-compatible { header, rows } shape', () => {
  const w = readWeights('MLB');
  assert.ok(w, 'MLB weights should load');
  assert.strictEqual(w.header, 'market,key,weight');
  assert.ok(Array.isArray(w.rows) && w.rows.length > 0);
  for (const r of w.rows) {
    assert.ok('market' in r && 'key' in r && 'weight' in r);
    assert.strictEqual(typeof r.key, 'string');
    assert.strictEqual(typeof r.weight, 'number');
    assert.ok(Number.isFinite(r.weight));
  }
});

test('param_ rows carry empty market; market weights carry a market', () => {
  const w = readWeights('MLB');
  const paramRow = w.rows.find(r => r.key === 'param_confidence_power');
  assert.ok(paramRow, 'param_confidence_power present');
  assert.strictEqual(paramRow.market, '');

  const mlRow = w.rows.find(r => r.market === 'moneyline' && r.key === 'run_differential_diff');
  assert.ok(mlRow, 'a moneyline weight is present');
  assert.strictEqual(mlRow.market, 'moneyline');
});

test('all four leagues load from JSON (no CSV files remain)', () => {
  for (const lg of ['MLB', 'NBA', 'NHL', 'NFL']) {
    const w = readWeights(lg);
    assert.ok(w && w.rows.length > 0, `${lg} weights should load from JSON`);
  }
  // The retired CSV directory must be gone.
  const weightsDir = path.join(__dirname, '..', 'weights');
  assert.strictEqual(fs.existsSync(weightsDir), false, 'legacy weights/ dir should be deleted');
});
