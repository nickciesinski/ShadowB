'use strict';
// 2026-09-10 — the Novig price shown in the evening digest.
//
// Novig is a prediction market: contracts trade in cents 0-100 and pay $1, so
// 41c is +140. Nick cannot use American odds there, and the whole reason he is
// betting there is to keep the sportsbook's ~1.7pp cut — which means a wrong
// number here does not look wrong, it just quietly hands the cut back.
//
// The number is a CEILING: pay this or less. So it must always round DOWN.
const test = require('node:test');
const assert = require('node:assert');
const { novigMaxCents } = require('../scripts/evening-digest');

test('matches the prices quoted for the 2026-09-11 slate', () => {
  // These are the exact figures given to Nick by hand. If the helper ever
  // disagrees with them, one of the two is wrong and both are in use.
  const expected = [[130, 41], [165, 36], [115, 44], [164, 36], [125, 42], [100, 47], [149, 38]];
  for (const [american, cents] of expected) {
    assert.strictEqual(novigMaxCents(american), cents, `${american} should be ${cents}c`);
  }
});

test('rounds down, never up', () => {
  // +140 is 41.67c. Quoting 42c would tell him to pay more than intended.
  assert.strictEqual(novigMaxCents(130), 41);
  // +110 is 47.62c -> 47, not 48.
  assert.strictEqual(novigMaxCents(100), 47);
});

test('a better American price is always a cheaper contract', () => {
  // Monotonicity: the longer the odds, the lower the cents. A break here means
  // favourites and dogs are being priced inconsistently.
  const prices = [100, 115, 130, 149, 165, 200, 400].map(novigMaxCents);
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] < prices[i - 1], `${prices[i]} should be below ${prices[i - 1]}`);
  }
});

test('negative odds work too', () => {
  // -110 improved by 10 cents is -100, i.e. even money, i.e. 50c.
  assert.strictEqual(novigMaxCents(-110), 50);
  // -150 is a FAVOURITE (60c implied). Improved to -140 it is 58.3c -> 58.
  // A favourite must stay expensive: a dog's price here would mean the sign
  // was mishandled, which is the easy mistake in American->cents conversion.
  assert.strictEqual(novigMaxCents(-150), 58);
  assert.ok(novigMaxCents(-150) > 50, 'favourites cost more than even money');
  assert.ok(novigMaxCents(150) < 50, 'dogs cost less than even money');
});

test('refuses anything that is not valid American odds', () => {
  // A null price must render as a dash, not as a confident 0c or 100c bet.
  for (const bad of [null, undefined, '', 'abc', NaN, 0, 50, -50, 99]) {
    assert.strictEqual(novigMaxCents(bad), null, `${bad} must not produce a price`);
  }
});

test('never returns a degenerate 0 or 100 cent price', () => {
  // A contract at 0c or 100c is not a bet. Extreme odds must return null
  // rather than a price that looks actionable.
  assert.strictEqual(novigMaxCents(100000), null);
});
