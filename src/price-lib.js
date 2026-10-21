'use strict';
// src/price-lib.js — R2.1 line-shopping price math.
// Pure, dependency-free, offline-testable. Given the per-book American prices
// available for one outcome, derive both the MEDIAN (what we log/grade against
// today) and the BEST available price (what line-shopping across 15+ books
// would have captured). Adding best alongside median is additive: it does NOT
// change which side or point we pick — only surfaces the price we left on the
// table. Wiring the grade path to best price is a deliberate later step.

// Most favorable American price to the bettor. For American odds the
// numerically largest value is always the best payout for the bettor
// (+120 > +100 > -105 > -110), so max across finite prices is correct.
function bestAmericanPrice(prices) {
  if (!Array.isArray(prices)) return null;
  let best = null;
  for (const p of prices) {
    const v = parseFloat(p);
    if (!Number.isFinite(v) || v === 0) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

// Median American price using the same convention as buildGameObjects:
// ascending sort, take element at floor(n/2). Junk/zero prices are dropped.
function medianAmericanPrice(prices) {
  if (!Array.isArray(prices)) return null;
  const clean = [];
  for (const p of prices) {
    const v = parseFloat(p);
    if (Number.isFinite(v) && v !== 0) clean.push(v);
  }
  if (clean.length === 0) return null;
  clean.sort((a, b) => a - b);
  return clean[Math.floor(clean.length / 2)];
}

// Both stats in one pass-friendly call. n = count of usable prices.
function priceStats(prices) {
  const median = medianAmericanPrice(prices);
  const best = bestAmericanPrice(prices);
  const n = Array.isArray(prices)
    ? prices.filter((p) => Number.isFinite(parseFloat(p)) && parseFloat(p) !== 0).length
    : 0;
  return { median, best, n };
}

// R2.1 step 2 — point the STAKED-pick grade path at the best price.
// Pure decision function: given a pick's approval status and the two prices
// already computed (median = today's logged/graded price, best = line-shopped
// price), decide which number the Performance Log should log/grade against.
//
// Rules (deliberately conservative):
//   - Only `approved` (staked) picks get the best price. tracking_only rows
//     keep logging median, unchanged -- this ticket only touches the units we
//     actually risk.
//   - Falls back to median whenever bestOdds isn't a usable finite number,
//     so a missing/odd bestPrice never breaks logging.
//   - Does NOT decide which side/outcome to bet -- callers must pass in the
//     price for the side that was ALREADY selected by the model.
function selectGradedPrice(approvalStatus, medianOdds, bestOdds) {
  if (approvalStatus === 'approved' && Number.isFinite(bestOdds)) {
    return bestOdds;
  }
  return medianOdds;
}

// 2026-10-21 — ported from ShadowB-Soccer (epl-v1.1.1). A spread/total MAIN
// line is priced near a coin flip by design (MLB/NHL run/puck lines reach about
// -280/+235). A single book quoting the main line outside 10-90% is a stale or
// junk quote, not a price; on the soccer side one such quote logged a level
// handicap at +2755 and "won" 13.8 units. buildGameObjects drops these quotes
// before taking Bovada/median/best, so one bad book can't set the price.
const MAIN_LINE_MIN_PROB = 0.10;
const MAIN_LINE_MAX_PROB = 0.90;
function isPlausibleMainLinePrice(price) {
  const v = parseFloat(price);
  if (!Number.isFinite(v) || Math.abs(v) < 100) return false; // same rule as isValidAmericanOdds
  const p = v > 0 ? 100 / (v + 100) : -v / (-v + 100);
  return p >= MAIN_LINE_MIN_PROB && p <= MAIN_LINE_MAX_PROB;
}

module.exports = { bestAmericanPrice, medianAmericanPrice, priceStats, selectGradedPrice, isPlausibleMainLinePrice };
