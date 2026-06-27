'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { withRetry } = require('../src/retry');

const silent = { warn() {}, log() {} };
const noSleep = async () => {};
const transientAll = () => true;

test('returns immediately on success (no retry)', async () => {
  let n = 0;
  const r = await withRetry('x', async () => { n++; return 42; }, { isTransient: transientAll, sleep: noSleep, log: silent });
  assert.strictEqual(r, 42);
  assert.strictEqual(n, 1);
});

test('rides out a transient token failure then succeeds', async () => {
  let n = 0;
  const r = await withRetry('auth.getAccessToken', async () => {
    n++;
    if (n < 4) throw new Error('oauth2/v4/token: Premature close');
    return { token: 'ok' };
  }, { tries: 6, baseMs: 1500, maxMs: 20000, isTransient: transientAll, sleep: noSleep, log: silent });
  assert.deepStrictEqual(r, { token: 'ok' });
  assert.strictEqual(n, 4);
});

test('exhausts after `tries` on persistent transient error and throws the last error', async () => {
  let n = 0;
  await assert.rejects(() => withRetry('auth', async () => { n++; throw new Error('Premature close'); },
    { tries: 6, isTransient: transientAll, sleep: noSleep, log: silent }), /Premature close/);
  assert.strictEqual(n, 6);
});

test('stops immediately (no retry) on a non-transient error', async () => {
  let n = 0;
  await assert.rejects(() => withRetry('x', async () => { n++; throw new Error('invalid_grant'); },
    { tries: 6, isTransient: () => false, sleep: noSleep, log: silent }), /invalid_grant/);
  assert.strictEqual(n, 1);
});

test('honors the maxMs backoff cap', async () => {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  await assert.rejects(() => withRetry('x', async () => { throw new Error('boom'); },
    { tries: 5, baseMs: 1500, maxMs: 4000, isTransient: transientAll, sleep, log: silent }));
  // backoff (pre-jitter) is min(maxMs, 1500*2^(n-1)) => 1500,3000,4000,4000; +<=250 jitter
  assert.strictEqual(delays.length, 4);
  for (const d of delays) assert.ok(d <= 4000 + 250, `delay ${d} exceeds cap+jitter`);
  assert.ok(delays[2] <= 4250 && delays[2] >= 4000, 'third delay should be capped near 4000');
});
