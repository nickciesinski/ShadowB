'use strict';
// 2026-09-10 — the report's two silent failure modes.
//
// The headline test is `fetchAll pages past the 1000-row cap`. PostgREST
// truncates any response to 1000 rows and returns no error, so a `.limit(20000)`
// read of a 1528-row table looked exactly like a complete one. The 2026-09-06
// report was computed on ~40% of the data because of it. If that test ever goes
// green while fetchAll stops at 1000, the report is quietly lying again.
const test = require('node:test');
const assert = require('node:assert');
const { fetchAll, buildRows, CONTRIB_SCHEMA_CHANGE } = require('../scripts/feature-clv-report');

/** A fake query builder that serves `total` rows in pages, like PostgREST. */
function fakeTable(total, capPerPage = 1000) {
  const calls = [];
  const build = () => ({
    range(from, to) {
      calls.push([from, to]);
      const want = Math.min(to - from + 1, capPerPage);
      const rows = [];
      for (let i = from; i < Math.min(from + want, total); i++) rows.push({ i });
      return Promise.resolve({ data: rows, error: null });
    },
  });
  return { build, calls };
}

test('fetchAll pages past the 1000-row cap', async () => {
  const { build, calls } = fakeTable(1528);
  const rows = await fetchAll(build, 'fake');
  assert.strictEqual(rows.length, 1528, 'must read every row, not the first 1000');
  assert.deepStrictEqual(calls[0], [0, 999]);
  assert.deepStrictEqual(calls[1], [1000, 1999]);
  assert.strictEqual(calls.length, 2, 'a short page ends the read');
});

test('fetchAll stops immediately on a short first page', async () => {
  const { build, calls } = fakeTable(42);
  const rows = await fetchAll(build, 'fake');
  assert.strictEqual(rows.length, 42);
  assert.strictEqual(calls.length, 1);
});

test('fetchAll handles an exact multiple of the page size', async () => {
  const { build, calls } = fakeTable(2000);
  const rows = await fetchAll(build, 'fake');
  assert.strictEqual(rows.length, 2000);
  // 2 full pages then an empty one — it cannot know it is done without asking.
  assert.strictEqual(calls.length, 3);
});

test('fetchAll surfaces an error instead of returning a short read', async () => {
  const build = () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
  await assert.rejects(() => fetchAll(build, 'ledger'), /ledger: boom/);
});

test('buildRows joins on pick_id and drops unmatched vectors', () => {
  const byPickId = new Map([
    ['p1', { game_key: 'g1', clv_prob_delta: 0.01 }],
    ['p2', { game_key: 'g1', clv_prob_delta: 0.02 }],
  ]);
  const feats = [
    { pick_id: 'p1', top_contributions: [{ feature: 'a', contribution: 1 }, { feature: 'b', contribution: 2 }] },
    { pick_id: 'p2', top_contributions: [{ feature: 'a', contribution: 3 }] },
    { pick_id: 'MISSING', top_contributions: [{ feature: 'a', contribution: 9 }] },
  ];
  const { rows, joined } = buildRows(feats, byPickId);
  assert.strictEqual(joined, 2, 'the unmatched vector is not counted as joined');
  assert.strictEqual(rows.length, 3);
  assert.ok(!rows.some(r => r.contribution === 9), 'unmatched contributions must not leak in');
  assert.ok(rows.every(r => r.gameKey === 'g1'), 'gameKey comes from the ledger, not the feature row');
});

test('buildRows tolerates a missing or malformed contributions array', () => {
  const byPickId = new Map([['p1', { game_key: 'g1', clv_prob_delta: 0.01 }]]);
  const { rows, joined } = buildRows([
    { pick_id: 'p1', top_contributions: null },
    { pick_id: 'p1', top_contributions: [null, { contribution: 5 }] },
  ], byPickId);
  assert.strictEqual(joined, 2);
  assert.strictEqual(rows.length, 0, 'entries with no feature name are skipped');
});

test('the schema-change boundary is the date the contributions shape changed', () => {
  // Hard-coded on purpose. Moving it re-pools two incomparable eras, which is
  // exactly the bug this split exists to prevent.
  assert.strictEqual(CONTRIB_SCHEMA_CHANGE, '2026-08-31');
});
