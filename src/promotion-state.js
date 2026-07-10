'use strict';
/**
 * src/promotion-state.js — self-resolving quarantine for the weight optimizer
 *
 * Background: the weekly weight sweep was quarantined to analysis-only on
 * 2026-06-21 (R0.1) because it showed no out-of-sample lift. That turned
 * "should the optimizer be allowed to write?" into a standing manual
 * decision. This module converts it into a rule:
 *
 *   QUARANTINED (default): scheduled runs analyze only, but every week the
 *     sweep's winner — selected on a TRAIN window — is scored on a HOLDOUT
 *     window it never saw. A qualifying holdout lift increments a streak;
 *     a miss resets it. `required_streak` consecutive qualifying weeks →
 *     PROMOTED (with an email).
 *
 *   PROMOTED: scheduled runs may apply (still subject to the per-run lift
 *     thresholds and clamp guardrails in auto-apply-weights.js). A week of
 *     genuine holdout degradation demotes straight back to QUARANTINED and
 *     resets the streak (with an email). drift-guard remains the live
 *     backstop behind all of this.
 *
 * Weeks with too small a holdout sample are recorded but change nothing —
 * neither reward nor punishment on noise.
 *
 * State lives in config/weight-promotion-state.json and is committed by the
 * weekly workflow so it persists across runs. Transition logic is pure and
 * offline-tested (test/promotion-state.test.js).
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'config', 'weight-promotion-state.json');

// Qualification thresholds — intentionally aligned with the per-run apply
// thresholds in auto-apply-weights.js, but measured OUT-OF-SAMPLE.
const QUALIFY_ROI_LIFT = 2.0;      // percentage points on holdout
const QUALIFY_WIN_LIFT = 1.0;      // percentage points on holdout
const MIN_HOLDOUT_SAMPLE = 30;     // graded picks in holdout to count either way
const REQUIRED_STREAK = 3;         // consecutive qualifying weeks to promote
const MAX_HISTORY = 26;            // ~6 months of weekly entries

function defaultState() {
  return {
    mode: 'quarantined',
    streak: 0,
    required_streak: REQUIRED_STREAK,
    history: [],
    updated: null,
    note: 'R0.1 quarantine (2026-06-21) converted to self-resolving rule on 2026-07-09. ' +
      `Promotes after ${REQUIRED_STREAK} consecutive weeks of qualifying out-of-sample lift; demotes on holdout degradation.`,
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { ...defaultState(), ...raw };
  } catch (_) {
    return defaultState();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Pure transition function.
 *
 * @param {Object} state    current state (not mutated)
 * @param {Object} holdout  { sample, roiLift, winRateLift, winnerName, date }
 *   sample:      graded picks in the holdout window
 *   roiLift:     winner ROI minus baseline ROI on holdout (pct points)
 *   winRateLift: winner win% minus baseline win% on holdout (pct points)
 * @returns {{ state, event: 'PROMOTED'|'DEMOTED'|null, verdict: string }}
 */
function evaluateTransition(state, holdout) {
  const s = JSON.parse(JSON.stringify(state || defaultState()));
  const h = holdout || {};
  let event = null;
  let verdict;

  const insufficient = !h.sample || h.sample < MIN_HOLDOUT_SAMPLE;
  const qualifies = !insufficient &&
    (h.roiLift >= QUALIFY_ROI_LIFT || h.winRateLift >= QUALIFY_WIN_LIFT);
  const degrades = !insufficient &&
    h.roiLift < 0 && h.winRateLift < 0;

  if (insufficient) {
    verdict = `insufficient_sample (${h.sample || 0} < ${MIN_HOLDOUT_SAMPLE}) — streak held at ${s.streak}`;
  } else if (s.mode === 'quarantined') {
    if (qualifies) {
      s.streak += 1;
      if (s.streak >= (s.required_streak || REQUIRED_STREAK)) {
        s.mode = 'promoted';
        event = 'PROMOTED';
        verdict = `qualifying lift — streak ${s.streak}/${s.required_streak} → PROMOTED`;
      } else {
        verdict = `qualifying lift — streak ${s.streak}/${s.required_streak}`;
      }
    } else {
      const had = s.streak;
      s.streak = 0;
      verdict = `no qualifying lift (ROI ${fmt(h.roiLift)}, win% ${fmt(h.winRateLift)})${had > 0 ? ` — streak reset from ${had}` : ''}`;
    }
  } else { // promoted
    if (degrades) {
      s.mode = 'quarantined';
      s.streak = 0;
      event = 'DEMOTED';
      verdict = `holdout degradation (ROI ${fmt(h.roiLift)}, win% ${fmt(h.winRateLift)}) → DEMOTED to quarantine`;
    } else {
      verdict = `holding promotion (ROI ${fmt(h.roiLift)}, win% ${fmt(h.winRateLift)})`;
    }
  }

  s.history.push({
    date: h.date || new Date().toISOString().slice(0, 10),
    winner: h.winnerName || null,
    sample: h.sample || 0,
    roiLift: round1(h.roiLift),
    winRateLift: round1(h.winRateLift),
    mode: s.mode,
    streak: s.streak,
    event,
    verdict,
  });
  if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
  s.updated = new Date().toISOString();

  return { state: s, event, verdict };
}

/**
 * Chronological train/holdout split for walk-forward validation.
 * Holdout = the most recent `holdoutDays` of picks; train = everything
 * before. Picks need a `dateISO` (YYYY-MM-DD) field.
 */
function splitTrainHoldout(picks, { holdoutDays = 14, now = new Date() } = {}) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - holdoutDays);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const train = [], holdout = [];
  for (const p of (picks || [])) {
    if (String(p.dateISO || '') >= cutoffISO) holdout.push(p);
    else train.push(p);
  }
  return { train, holdout, cutoffISO };
}

function fmt(v) { return v == null || isNaN(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${round1(v)}`; }
function round1(v) { return v == null || isNaN(v) ? null : parseFloat(Number(v).toFixed(1)); }

module.exports = {
  loadState, saveState, evaluateTransition, splitTrainHoldout, defaultState,
  STATE_PATH, QUALIFY_ROI_LIFT, QUALIFY_WIN_LIFT, MIN_HOLDOUT_SAMPLE, REQUIRED_STREAK,
};
