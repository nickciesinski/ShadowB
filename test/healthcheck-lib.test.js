'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isTransientError, withRetry, diverges } = require('../scripts/healthcheck-lib');

test('the reported OAuth "Premature close" error is classified transient', () => {
  const e = new Error('Invalid response body while trying to fetch https://www.googleapis.com/oauth2/v4/token: Premature close');
  assert.strictEqual(isTransientError(e), true);
});

test('common infra errors are transient', () => {
  for (const m of ['socket hang up', 'ECONNRESET', 'ETIMEDOUT', 'getaddrinfo EAI_AGAIN', 'fetch failed', 'request timed out', 'server returned 503']) {
    assert.strictEqual(isTransientError(new Error(m)), true, m);
  }
});

test('real data/logic errors are NOT transient (so they still surface)', () => {
  for (const m of ['column "foo" does not exist', 'permission denied for table', 'invalid API key', 'row-count divergence']) {
    assert.strictEqual(isTransientError(new Error(m)), false, m);
  }
});

test('withRetry recovers from a transient blip then succeeds', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('Premature close');
    return 'ok';
  }, { tries: 3, sleep: async () => {} });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 3);
});

test('withRetry does NOT retry a non-transient error (fails fast)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('permission denied'); }, { tries: 5, sleep: async () => {} }),
    /permission denied/
  );
  assert.strictEqual(calls, 1);
});

test('withRetry rethrows after exhausting tries on persistent transient failure', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('ECONNRESET'); }, { tries: 3, sleep: async () => {} }),
    /ECONNRESET/
  );
  assert.strictEqual(calls, 3);
});

test('diverges: only flags gaps that are both >2 rows and >10%', () => {
  assert.strictEqual(diverges(2956, 2956), false); // identical
  assert.strictEqual(diverges(100, 102), false);   // 2-row gap, within tolerance
  assert.strictEqual(diverges(100, 130), true);    // 30% gap
  assert.strictEqual(diverges(2956, 2900), false); // 56 rows but <10%? 56 < 295.6 -> not divergent
  assert.strictEqual(diverges(50, 60), true);      // 10 rows, 20%
});
