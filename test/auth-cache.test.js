'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isUsableToken, MIN_REMAINING_MS } = require('../src/auth-cache');

const NOW = Date.parse('2026-06-28T12:00:00Z');
const inMin = (m) => NOW + m * 60000;

test('a token with plenty of life left is reusable (skip the flaky endpoint)', () => {
  assert.strictEqual(isUsableToken({ access_token: 'abc', expiry_date: inMin(45) }, NOW), true);
});

test('a token expiring within the safety margin is NOT reused (avoid mid-run expiry)', () => {
  assert.strictEqual(isUsableToken({ access_token: 'abc', expiry_date: inMin(10) }, NOW), false);
  // boundary: exactly the margin is OK, just under is not
  assert.strictEqual(isUsableToken({ access_token: 'abc', expiry_date: NOW + MIN_REMAINING_MS }, NOW), true);
  assert.strictEqual(isUsableToken({ access_token: 'abc', expiry_date: NOW + MIN_REMAINING_MS - 1 }, NOW), false);
});

test('an already-expired token is not reusable', () => {
  assert.strictEqual(isUsableToken({ access_token: 'abc', expiry_date: inMin(-5) }, NOW), false);
});

test('null / malformed cache entries are not reusable (fall through to fresh fetch)', () => {
  assert.strictEqual(isUsableToken(null, NOW), false);
  assert.strictEqual(isUsableToken({}, NOW), false);
  assert.strictEqual(isUsableToken({ access_token: 'abc' }, NOW), false);          // no expiry
  assert.strictEqual(isUsableToken({ expiry_date: inMin(45) }, NOW), false);        // no token
  assert.strictEqual(isUsableToken({ access_token: 'abc', expiry_date: 'soon' }, NOW), false);
});

test('margin exceeds the longest observed trigger runtime (trigger14 ~12min)', () => {
  assert.ok(MIN_REMAINING_MS >= 15 * 60000);
});
