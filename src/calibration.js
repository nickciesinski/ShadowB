'use strict';
// =============================================================
// src/calibration.js — put the model's output on a probability scale
//
// 2026-08-31 (R3.3). The model reports an average +13.1pp edge over the
// market and measures +0.20pp. Its output is not a probability; it is a score
// that happens to live in [0,1]. Everything downstream that treats it as a
// probability - confidence, and therefore stake - is keying off a fiction.
// That is why 78% of the bankroll sits on confidence 10.
//
// The fix is not a better model, it is a scale. Fit
//     logit(p) = a + b*logit(model) + c*logit(market)
// on settled picks and use the result wherever a real probability is needed.
//
// What it does and does not buy, measured walk-forward by week:
//     raw model output        log loss 0.7266
//     market price alone               0.6764
//     model + market                   0.6766
// Recalibration is a large win over the raw model. It does NOT beat the market
// price - c comes out near 1 and b is indistinguishable from zero (t=0.16).
// Recalibration removes a fictitious edge; it does not create a real one.
//
// REPORTING-ONLY on arrival. Nothing reads calibrated_prob to size or select.
// Wiring it into staking is a separate, deliberate change, and only after the
// logged calibrated values have been watched against outcomes for a while.
// =============================================================

const fs = require('fs');
const path = require('path');

const cache = {};

function loadCalibration(league, dir) {
  const key = String(league || '').toUpperCase();
  if (!dir && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  const file = path.join(dir || path.join(__dirname, '..', 'config'), `calibration.${key}.json`);
  let cfg = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = parsed && parsed.coefficients;
    if (c && ['a', 'b', 'c'].every(k => Number.isFinite(Number(c[k])))) {
      cfg = { a: Number(c.a), b: Number(c.b), c: Number(c.c) };
    }
  } catch (err) { cfg = null; }
  if (!dir) cache[key] = cfg;
  return cfg;
}

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * Calibrated win probability for the side taken.
 *
 * Returns null when it cannot be computed - never the raw value. Silently
 * falling back to the uncalibrated number would reintroduce the exact fiction
 * this module exists to remove, and it would do so invisibly.
 *
 * @param {string} league
 * @param {number} modelProb   raw model output for the chosen side
 * @param {number} marketProb  no-vig market probability for that side
 * @param {object} [cfg]       injected coefficients (tests)
 * @returns {number|null} calibrated probability in (0,1)
 */
function calibrate(league, modelProb, marketProb, cfg = undefined) {
  const k = cfg === undefined ? loadCalibration(league) : cfg;
  if (!k) return null;
  const m = Number(modelProb), q = Number(marketProb);
  if (!Number.isFinite(m) || !Number.isFinite(q)) return null;
  // logit is undefined at the endpoints; clamp rather than emit Infinity.
  const EPS = 1e-6;
  const mc = Math.min(1 - EPS, Math.max(EPS, m));
  const qc = Math.min(1 - EPS, Math.max(EPS, q));
  if (m <= 0 || m >= 1 || q <= 0 || q >= 1) {
    // Out-of-range inputs mean something upstream is wrong. A clamped answer
    // would look plausible and hide it.
    return null;
  }
  const z = k.a + k.b * logit(mc) + k.c * logit(qc);
  const p = sigmoid(z);
  return Number.isFinite(p) ? p : null;
}

/** Calibrated edge over the price, in probability points. Null-safe. */
function calibratedEdge(league, modelProb, marketProb, cfg = undefined) {
  const p = calibrate(league, modelProb, marketProb, cfg);
  if (p == null) return null;
  const q = Number(marketProb);
  if (!Number.isFinite(q)) return null;
  return p - q;
}

module.exports = { calibrate, calibratedEdge, loadCalibration, logit, sigmoid };
