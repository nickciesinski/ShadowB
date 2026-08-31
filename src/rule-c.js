'use strict';
// =============================================================
// src/rule-c.js — pre-registration of the candidate staking rule
//
// 2026-08-31. The kill criterion in daily-validation.js has effectively
// fired: pooled net edge -1.483pp at t -21.61, roughly 30 standard errors
// below the +0.005 bar. Two filters recover most of that gap:
//
//   plus money only            -1.483 -> -0.700pp
//   + top-half disagreement    -0.700 -> -0.417pp
//
// Both were found by slicing the SAME 735 rows they are scored on, which is
// exactly the trap checkMeasurement() warns about ("nine slices on 150 rows
// will throw a t of 3 by chance"). So the rule is written down BEFORE it is
// allowed to touch money: every pick gets stamped with whether it qualifies,
// nothing is staked differently, and the forward sample becomes a clean
// out-of-sample test.
//
// THIS FILE MUST NOT INFLUENCE STAKING. It is a labeller. If a future change
// wants to gate stake on rule C, that is a separate, deliberate commit made
// after the forward sample confirms the rule - not a flag flipped in here.
//
// Why a fixed threshold instead of a nightly percentile: "top half of tonight's
// slate" drifts with slate composition and cannot be audited months later. A
// pinned number (the median of the reference population) is reproducible, and
// reproducing rule C from it returns the identical 148 rows.
// =============================================================

const path = require('path');

let cached = null;
function loadRuleConfig(dir) {
  if (cached && !dir) return cached;
  const file = path.join(dir || path.join(__dirname, '..', 'config'), 'rule-c.json');
  let cfg;
  try {
    cfg = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  } catch (err) {
    // Fail closed: an unreadable config must not silently stamp everything
    // eligible. A null stamp reads as "not evaluated", which is honest.
    return null;
  }
  const minOdds = Number(cfg.minAmericanOdds);
  const minDis = Number(cfg.minDisagreement);
  if (!Number.isFinite(minOdds) || !Number.isFinite(minDis)) return null;
  const out = { minAmericanOdds: minOdds, minDisagreement: minDis };
  if (!dir) cached = out;
  return out;
}

/**
 * Would this pick qualify under the pre-registered rule?
 *
 * @param {object} p
 * @param {number} [p.odds]           price logged for this ticket (American)
 * @param {number} [p.bestOdds]       best available price for the chosen side
 * @param {number} [p.predictedProb]  model probability for the chosen side
 * @param {number} [p.marketProb]     no-vig market probability for that side
 * @param {object} [cfg]              injected config (tests)
 * @returns {boolean|null} null when it cannot be evaluated - never a guess
 */
function isRuleCEligible(p = {}, cfg = undefined) {
  const c = cfg === undefined ? loadRuleConfig() : cfg;
  if (!c) return null;

  // Evaluate on the price we would actually take. best_odds is the line-shopped
  // figure; approved tickets already log it, tracking_only tickets log the
  // consensus median. Preferring bestOdds keeps the label on one basis
  // regardless of approval status, so the flag stays comparable if MLB moves
  // to tracking-only.
  const price = Number.isFinite(Number(p.bestOdds)) && Number(p.bestOdds) !== 0
    ? Number(p.bestOdds)
    : Number(p.odds);
  const pred = Number(p.predictedProb);
  const mkt = Number(p.marketProb);
  if (!Number.isFinite(price) || price === 0) return null;
  if (!Number.isFinite(pred) || !Number.isFinite(mkt)) return null;
  // Probabilities out of range mean something upstream is wrong; don't label.
  if (pred <= 0 || pred >= 1 || mkt <= 0 || mkt >= 1) return null;

  return price >= c.minAmericanOdds && (pred - mkt) >= c.minDisagreement;
}

module.exports = { isRuleCEligible, loadRuleConfig };
