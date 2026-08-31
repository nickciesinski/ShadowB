'use strict';
// =============================================================
// src/venue-cost.js — what a bet actually costs, per venue
//
// 2026-08-31. Background: net_edge = clv_prob_delta - vig_paid_pp, and
// vig_paid_pp is computed in clv.js as (placedImplied - placed_novig_prob):
// the probability overcharge baked into a sportsbook price. That definition
// silently assumes the cost of getting on is a BOOK HOLD.
//
// On an exchange there is no hold. The cost is an explicit per-contract fee,
// and a contract paying $1 is priced in dollars that ARE probability - so the
// fee is already in probability points and drops into the same slot with no
// conversion. But if we point the system at an exchange and keep computing
// cost from the sportsbook consensus, net_edge becomes a number about a venue
// we did not use. That is the same failure shape as close_odds=-1 and the
// col-31/col-33 blindness: a measurement that keeps reporting confidently
// while describing the wrong thing.
//
// This module exists so the venue question can be answered numerically before
// any money moves. It is analysis-only - nothing in the live grade path calls
// it, and clv.js still measures real sportsbook tickets the way it always has.
//
// Fee schedules are in config/venues.json with a per-venue confidence field.
// An unknown venue returns null, never 0: "we do not know" must never be
// silently rendered as "free", which would make a venue look profitable for
// no reason other than our own ignorance.
// =============================================================

const fs = require('fs');
const path = require('path');

let cache = null;
function loadVenues(dir) {
  if (cache && !dir) return cache;
  const file = path.join(dir || path.join(__dirname, '..', 'config'), 'venues.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; }
  if (!cfg || !cfg.venues) return null;
  if (!dir) cache = cfg.venues;
  return cfg.venues;
}

/**
 * Cost of getting on, in probability points (a fraction: 0.0075 = 0.75pp).
 *
 * @param {string} venue   key in config/venues.json
 * @param {number} price   contract price / fair probability of the side taken
 * @param {string} [role]  'taker' (default) or 'maker'
 * @param {object} [venues] injected config (tests)
 * @returns {number|null} null when the venue is unknown or unmodelled
 */
function venueCost(venue, price, role = 'taker', venues = undefined) {
  const v = (venues === undefined ? loadVenues() : venues);
  if (!v) return null;
  const spec = v[String(venue || '').toLowerCase()];
  if (!spec || spec.model !== 'quadratic') return null; // 'measured'/'unknown' -> caller must use the real figure
  const side = spec[role === 'maker' ? 'maker' : 'taker'];
  if (!side || !Number.isFinite(Number(side.coefficient))) return null;

  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;

  let fee = Number(side.coefficient) * p * (1 - p);
  if (Number.isFinite(Number(side.capPerContract))) fee = Math.min(fee, Number(side.capPerContract));
  return fee;
}

/**
 * Net edge if this ticket had been placed at `venue` instead.
 * Assumes the exchange quotes the same fair line as the book consensus - the
 * load-bearing assumption in the whole comparison, and the one that a live
 * fill test is needed to check. A wider exchange spread eats the fee saving.
 *
 * @returns {number|null}
 */
function netEdgeAtVenue(clvProbDelta, venue, price, role = 'taker', venues = undefined) {
  // Number(null) === 0 and Number('') === 0, both finite - so a missing CLV
  // would silently price as "zero edge" and return a confident negative number.
  // Reject the empty cases explicitly before coercing.
  if (clvProbDelta === null || clvProbDelta === undefined || clvProbDelta === '') return null;
  const clv = Number(clvProbDelta);
  if (!Number.isFinite(clv)) return null;
  const cost = venueCost(venue, price, role, venues);
  if (cost == null) return null;
  return clv - cost;
}

module.exports = { venueCost, netEdgeAtVenue, loadVenues };
