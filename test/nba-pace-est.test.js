'use strict';
// 2026-10-16 — NBA pace estimate, a weight-0 CANDIDATE. ESPN publishes no
// pace stat, so it is estimated from box-score averages and kept out of picks.
const test = require('node:test');
const assert = require('node:assert');
const { nbaPaceEstimate } = require('../src/data-collection');
const { extractFeatures } = require('../src/game-features');
const NBA = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../config/model-params.NBA.json'), 'utf8'));

// Boston, live ESPN values 2026-10-16.
const bos = { 'offensive.avgFieldGoalsAttempted': 90.21951, 'offensive.avgFreeThrowsAttempted': 18.707317,
  'offensive.avgOffensiveRebounds': 12.5, 'offensive.avgTurnovers': 11.5 };

test('estimate matches FGA + 0.44*FTA - OREB + TOV', () => {
  assert.ok(Math.abs(nbaPaceEstimate(bos) - 97.45) < 0.01);
});

test('missing stat or implausible result gives blank, never a number', () => {
  assert.strictEqual(nbaPaceEstimate({ ...bos, 'offensive.avgTurnovers': undefined }), '');
  assert.strictEqual(nbaPaceEstimate({ ...bos, 'offensive.avgFieldGoalsAttempted': 900 }), '');
});

test('feature is computed for NBA and weighted 0 in every market', () => {
  const t = { pct: '0.5', paceEst: '103' };
  const f = extractFeatures(t, { pct: '0.5', paceEst: '103' }, {}, 'NBA');
  assert.ok(Math.abs(f.nba_pace_est - 1) < 1e-9);
  for (const m of ['moneyline', 'spread', 'total']) assert.strictEqual(NBA[m].nba_pace_est, 0);
});

test('live pace features are untouched by paceEst', () => {
  const withEst = extractFeatures({ pct: '0.5', paceEst: '103' }, { pct: '0.5', paceEst: '93' }, {}, 'NBA');
  const without = extractFeatures({ pct: '0.5' }, { pct: '0.5' }, {}, 'NBA');
  for (const k of ['pace_diff', 'pace_factor', 'pace_combined', 'nba_pace_adj_net']) {
    assert.strictEqual(withEst[k], without[k], k);
  }
});
