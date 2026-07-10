'use strict';
// test/promotion-state.test.js — the self-resolving weight-optimizer
// quarantine (Phase 3). Pure logic; no network/Sheets.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  evaluateTransition, splitTrainHoldout, defaultState,
  MIN_HOLDOUT_SAMPLE, REQUIRED_STREAK,
} = require('../src/promotion-state');
const { computeNudges, applyNudges, factorAppliesTo, TUNABLE_FACTORS } = require('../src/game-optimizer');

const goodWeek = { sample: 60, roiLift: 3.5, winRateLift: 1.4, winnerName: 'test-combo' };
const flatWeek = { sample: 60, roiLift: 0.2, winRateLift: 0.1, winnerName: 'test-combo' };
const badWeek = { sample: 60, roiLift: -2.1, winRateLift: -1.0, winnerName: 'test-combo' };
const thinWeek = { sample: 10, roiLift: 8.0, winRateLift: 5.0, winnerName: 'test-combo' };

test('fresh state is quarantined with zero streak', () => {
  const s = defaultState();
  assert.strictEqual(s.mode, 'quarantined');
  assert.strictEqual(s.streak, 0);
  assert.strictEqual(s.required_streak, REQUIRED_STREAK);
});

test('promotion requires the full consecutive streak', () => {
  let s = defaultState();
  let r;
  r = evaluateTransition(s, goodWeek);
  assert.strictEqual(r.state.streak, 1);
  assert.strictEqual(r.state.mode, 'quarantined');
  assert.strictEqual(r.event, null);

  r = evaluateTransition(r.state, goodWeek);
  assert.strictEqual(r.state.streak, 2);
  assert.strictEqual(r.state.mode, 'quarantined');

  r = evaluateTransition(r.state, goodWeek);
  assert.strictEqual(r.state.streak, 3);
  assert.strictEqual(r.state.mode, 'promoted');
  assert.strictEqual(r.event, 'PROMOTED');
});

test('a flat week resets the streak — consecutive means consecutive', () => {
  let s = defaultState();
  s = evaluateTransition(s, goodWeek).state;
  s = evaluateTransition(s, goodWeek).state;
  assert.strictEqual(s.streak, 2);
  const r = evaluateTransition(s, flatWeek);
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.state.mode, 'quarantined');
  assert.strictEqual(r.event, null);
});

test('insufficient holdout sample HOLDS the streak — noise neither rewards nor punishes', () => {
  let s = defaultState();
  s = evaluateTransition(s, goodWeek).state;
  s = evaluateTransition(s, goodWeek).state;
  const r = evaluateTransition(s, thinWeek); // huge lift but tiny sample
  assert.strictEqual(r.state.streak, 2, 'streak unchanged');
  assert.strictEqual(r.state.mode, 'quarantined');
  assert.match(r.verdict, /insufficient_sample/);
  // ...and the streak can still complete afterward
  const done = evaluateTransition(r.state, goodWeek);
  assert.strictEqual(done.event, 'PROMOTED');
});

test('promoted mode demotes on genuine holdout degradation', () => {
  let s = defaultState();
  s.mode = 'promoted'; s.streak = 3;
  const r = evaluateTransition(s, badWeek);
  assert.strictEqual(r.state.mode, 'quarantined');
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.event, 'DEMOTED');
});

test('promoted mode holds on flat or mixed weeks (only real degradation demotes)', () => {
  let s = defaultState();
  s.mode = 'promoted'; s.streak = 3;
  assert.strictEqual(evaluateTransition(s, flatWeek).state.mode, 'promoted');
  // Mixed: ROI down but win rate up → not degradation
  const mixed = { sample: 60, roiLift: -1.0, winRateLift: 0.8, winnerName: 'x' };
  assert.strictEqual(evaluateTransition(s, mixed).state.mode, 'promoted');
  // Thin bad week → held, not demoted
  const thinBad = { sample: 12, roiLift: -9, winRateLift: -5, winnerName: 'x' };
  assert.strictEqual(evaluateTransition(s, thinBad).state.mode, 'promoted');
});

test('history is appended with verdicts and capped', () => {
  let s = defaultState();
  for (let i = 0; i < 30; i++) s = evaluateTransition(s, flatWeek).state;
  assert.ok(s.history.length <= 26);
  const last = s.history[s.history.length - 1];
  assert.strictEqual(last.sample, 60);
  assert.ok(last.verdict.length > 0);
});

test('qualification thresholds: ROI OR win-rate lift qualifies', () => {
  let s = defaultState();
  const roiOnly = { sample: 60, roiLift: 2.5, winRateLift: 0.0 };
  const winOnly = { sample: 60, roiLift: 0.0, winRateLift: 1.2 };
  assert.strictEqual(evaluateTransition(s, roiOnly).state.streak, 1);
  assert.strictEqual(evaluateTransition(s, winOnly).state.streak, 1);
  assert.strictEqual(MIN_HOLDOUT_SAMPLE, 30);
});

// ── walk-forward split ───────────────────────────────────────────

test('splitTrainHoldout: chronological, holdout = most recent window', () => {
  const now = new Date(2026, 6, 9); // July 9
  const picks = [
    { dateISO: '2026-05-15', id: 'old1' },
    { dateISO: '2026-06-20', id: 'old2' },
    { dateISO: '2026-06-26', id: 'recent1' }, // within 14d of Jul 9 (cutoff Jun 25)
    { dateISO: '2026-07-08', id: 'recent2' },
  ];
  const { train, holdout, cutoffISO } = splitTrainHoldout(picks, { holdoutDays: 14, now });
  assert.strictEqual(cutoffISO, '2026-06-25');
  assert.deepStrictEqual(train.map(p => p.id), ['old1', 'old2']);
  assert.deepStrictEqual(holdout.map(p => p.id), ['recent1', 'recent2']);
});

test('splitTrainHoldout tolerates empty input', () => {
  const { train, holdout } = splitTrainHoldout([], { holdoutDays: 14 });
  assert.strictEqual(train.length + holdout.length, 0);
});

// ── goalie signal graduation (league scoping + sample gate) ──────

function synthAnalysis(total, marginWinRate) {
  // Build a minimal analysis object shaped like analyzeGamePerformance output
  const half = Math.floor(total / 2);
  const mkPicks = (w, l) => ({
    wins: Array.from({ length: w }, () => ({ confidence: 6, unitReturn: 0.1, units: 0.1 })),
    losses: Array.from({ length: l }, () => ({ confidence: 5, unitReturn: -0.1, units: 0.1 })),
  });
  const mW = Math.round(half * marginWinRate), mL = half - mW;
  return {
    total,
    totalW: mW * 2 + Math.round(half * 0.5),
    totalL: mL * 2 + (half - Math.round(half * 0.5)),
    picks: {
      moneyline: mkPicks(mW, mL),
      spread: mkPicks(mW, mL),
      total: mkPicks(Math.round(half * 0.5), half - Math.round(half * 0.5)),
    },
  };
}

test('goalie_adj_scale is league-scoped to NHL', () => {
  assert.strictEqual(factorAppliesTo(TUNABLE_FACTORS.goalie_adj_scale, 'NHL'), true);
  assert.strictEqual(factorAppliesTo(TUNABLE_FACTORS.goalie_adj_scale, 'MLB'), false);
  assert.strictEqual(factorAppliesTo(TUNABLE_FACTORS.csv_dampen, 'MLB'), true, 'unscoped factors apply everywhere');
});

test('goalie nudge stays neutral below the 150-pick graduation gate', () => {
  const analysis = synthAnalysis(100, 0.65); // strong margins but small sample
  // NB: totalW/totalL in synthAnalysis are approximate; force the gate values
  analysis.totalW = 60; analysis.totalL = 40;
  const nhlFactors = { goalie_adj_scale: 0.5, confidence_power: 1.4, strength_blend_winpct: 0.35, strength_blend_scoring: 0.4, strength_blend_form: 0.25, margin_home_advantage: 1, margin_form_influence: 0.5, margin_rest_impact: 1, total_market_anchor: 0.95, total_pace_dampening: 0.3, csv_dampen: 0.3 };
  const nudges = computeNudges(analysis, nhlFactors, null);
  assert.strictEqual(nudges.goalie_adj_scale, 1.0, 'no nudge before graduation');
});

test('goalie nudge activates after graduation and follows margin performance', () => {
  const up = synthAnalysis(200, 0.62);
  up.totalW = 120; up.totalL = 80;
  const nhlFactors = { goalie_adj_scale: 0.5, confidence_power: 1.4, strength_blend_winpct: 0.35, strength_blend_scoring: 0.4, strength_blend_form: 0.25, margin_home_advantage: 1, margin_form_influence: 0.5, margin_rest_impact: 1, total_market_anchor: 0.95, total_pace_dampening: 0.3, csv_dampen: 0.3 };
  assert.strictEqual(computeNudges(up, nhlFactors, null).goalie_adj_scale, 1.01);

  const down = synthAnalysis(200, 0.38);
  down.totalW = 90; down.totalL = 110;
  assert.strictEqual(computeNudges(down, nhlFactors, null).goalie_adj_scale, 0.99);
});

test('applyNudges skips league-scoped factors absent from other leagues (no NaN pollution)', () => {
  const mlbFactors = { confidence_power: 1.4, strength_blend_winpct: 0.35, strength_blend_scoring: 0.4, strength_blend_form: 0.25, margin_home_advantage: 1, margin_form_influence: 0.5, margin_rest_impact: 1, total_market_anchor: 0.95, total_pace_dampening: 0.3, csv_dampen: 0.3 };
  const updated = applyNudges(mlbFactors, { goalie_adj_scale: 1.01 });
  assert.strictEqual(updated.goalie_adj_scale, undefined, 'must not appear in MLB factors');
  assert.ok(!Object.values(updated).some(v => isNaN(v)), 'no NaN anywhere');
});

test('applyNudges clamps goalie scale within [0.25, 0.75] for NHL', () => {
  const nhlFactors = { goalie_adj_scale: 0.74, confidence_power: 1.4, strength_blend_winpct: 0.35, strength_blend_scoring: 0.4, strength_blend_form: 0.25, margin_home_advantage: 1, margin_form_influence: 0.5, margin_rest_impact: 1, total_market_anchor: 0.95, total_pace_dampening: 0.3, csv_dampen: 0.3 };
  const updated = applyNudges(nhlFactors, { goalie_adj_scale: 1.05 });
  assert.ok(updated.goalie_adj_scale <= 0.75);
});
