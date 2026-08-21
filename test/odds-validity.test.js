'use strict';
// 2026-08-21: pins the American-odds validity guard that closes the price-layer
// break. close_odds = -1 (a feed sentinel that reached id 114721) is finite, so
// the old `Number.isFinite(price)` check in clv.js/buildPriceMap let it into the
// snapshot median. It then froze as a no-vig close of 0.0178 and a CLV of
// -0.4714 -- a 47-pp swing the integrity check correctly called impossible,
// which declared the whole Price layer untrustworthy. isValidAmericanOdds is the
// single guard both the capture (buildPriceMap) and freeze paths now share.
const test = require('node:test');
const assert = require('node:assert');
const { isValidAmericanOdds, americanToImpliedProb, removeVig } = require('../src/market-pricing');

test('isValidAmericanOdds: real quotes (|odds| >= 100) pass', () => {
  for (const o of [100, -100, -105, -110, -120, 150, 200, -200, 100.0]) {
    assert.strictEqual(isValidAmericanOdds(o), true, `${o} should be valid`);
  }
});

test('isValidAmericanOdds: sentinels and parse artifacts (|odds| < 100) fail', () => {
  // -1 is the exact value that broke id 114721.
  for (const o of [-1, 0, 1, 5, -50, 99, -99]) {
    assert.strictEqual(isValidAmericanOdds(o), false, `${o} should be rejected`);
  }
});

test('isValidAmericanOdds: non-numeric input fails, not throws', () => {
  for (const o of [null, undefined, NaN, '', 'x', Infinity, -Infinity]) {
    assert.strictEqual(isValidAmericanOdds(o), false, `${JSON.stringify(o)} should be rejected`);
  }
  // Numeric strings are still parsed (snapshot rows arrive as strings).
  assert.strictEqual(isValidAmericanOdds('-110'), true);
  assert.strictEqual(isValidAmericanOdds('-1'), false);
});

test('the guard blocks the exact 114721 corruption before it becomes a CLV', () => {
  // The old path: -1 slipped through, de-vigged against -120, and produced the
  // impossible close no-vig prob and CLV that broke the layer.
  const [novigWithBadPrice] = removeVig(
    americanToImpliedProb(-1), americanToImpliedProb(-120),
  );
  assert.ok(Math.abs(novigWithBadPrice - 0.0178) < 0.0002,
    'reproduces the stored 0.0178 so the fix targets the right defect');
  // The new path never lets -1 into the pool in the first place.
  assert.strictEqual(isValidAmericanOdds(-1), false);
});
