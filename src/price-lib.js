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

module.exports = { bestAmericanPrice, medianAmericanPrice, priceStats };
