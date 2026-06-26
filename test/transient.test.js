'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isTransient } = require('../src/transient');

test('REGRESSION: the OAuth token "Premature close" that failed every trigger is transient', () => {
  const e = new Error('Invalid response body while trying to fetch https://www.googleapis.com/oauth2/v4/token: Premature close');
  assert.strictEqual(isTransient(e), true);
});

test('detects the transport error when nested under err.cause (undici wrapping)', () => {
  const inner = new Error('Premature close');
  inner.code = 'ERR_STREAM_PREMATURE_CLOSE';
  const outer = new Error('request to token endpoint failed');
  outer.cause = inner;
  assert.strictEqual(isTransient(outer), true);
});

test('existing transient conditions still classify (no regression)', () => {
  assert.strictEqual(isTransient(new Error('The service is currently unavailable.')), true);
  assert.strictEqual(isTransient(new Error('Quota exceeded for quota metric')), true);
  assert.strictEqual(isTransient(new Error('socket hang up')), true);
  const e503 = new Error('boom'); e503.code = 503; assert.strictEqual(isTransient(e503), true);
  const eRst = new Error('boom'); eRst.code = 'ECONNRESET'; assert.strictEqual(isTransient(eRst), true);
  const eStatus = new Error('boom'); eStatus.response = { status: 429 }; assert.strictEqual(isTransient(eStatus), true);
});

test('MUST NOT retry: "exceeds grid limits" stays non-transient (auto-expand path depends on it)', () => {
  assert.strictEqual(isTransient(new Error('exceeds grid limits')), false);
});

test('MUST NOT retry: a genuinely bad key (invalid_grant) is non-transient', () => {
  assert.strictEqual(isTransient(new Error('invalid_grant: Invalid JWT Signature')), false);
  assert.strictEqual(isTransient(new Error('permission denied')), false);
  assert.strictEqual(isTransient(new Error('Requested entity was not found')), false);
});

test('null/undefined errors are non-transient', () => {
  assert.strictEqual(isTransient(null), false);
  assert.strictEqual(isTransient(undefined), false);
});
