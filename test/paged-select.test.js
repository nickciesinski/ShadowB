'use strict';
// 2026-09-10 — the 1000-row cap.
//
// PostgREST truncates any response to 1000 rows and returns no error, so
// `.limit(5000)` is not a bigger read, it is a silent subset. The measurement
// layer crossed that line between 2026-08-31 (735 baseline rows) and
// 2026-09-10 (1161), which quietly turned the kill-criterion net-edge figure
// into a statistic about an arbitrary 1000 of them.
//
// The headline test is `reads past 1000 rows`. If it ever goes green while
// pagedSelect stops at one page, every downstream number is on partial data.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

/** A fake builder that serves `total` rows, capped per page like PostgREST. */
function fakeTable(total, capPerPage = 1000) {
  const calls = [];
  return {
    calls,
    build: () => ({
      range(from, to) {
        calls.push([from, to]);
        const want = Math.min(to - from + 1, capPerPage);
        const rows = [];
        for (let i = from; i < Math.min(from + want, total); i++) rows.push({ id: i });
        return Promise.resolve({ data: rows, error: null });
      },
    }),
  };
}

test('reads past 1000 rows', async () => {
  const { build, calls } = fakeTable(1161); // the real measurement-layer count
  const rows = await db.pagedSelect(build, 'test');
  assert.strictEqual(rows.length, 1161, 'must not stop at the PostgREST cap');
  assert.deepStrictEqual(calls[0], [0, 999]);
  assert.deepStrictEqual(calls[1], [1000, 1999]);
});

test('rows come back in order and without duplicates', async () => {
  const { build } = fakeTable(2500);
  const rows = await db.pagedSelect(build, 'test');
  assert.strictEqual(rows.length, 2500);
  assert.strictEqual(new Set(rows.map(r => r.id)).size, 2500, 'no row read twice');
  assert.deepStrictEqual(rows.map(r => r.id).slice(0, 3), [0, 1, 2]);
});

test('a single short page ends the read immediately', async () => {
  const { build, calls } = fakeTable(12);
  const rows = await db.pagedSelect(build, 'test');
  assert.strictEqual(rows.length, 12);
  assert.strictEqual(calls.length, 1);
});

test('an empty table returns an empty array, not null', async () => {
  const { build } = fakeTable(0);
  assert.deepStrictEqual(await db.pagedSelect(build, 'test'), []);
});

test('an error on the first page returns null rather than a wrong answer', async () => {
  const build = () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
  assert.strictEqual(await db.pagedSelect(build, 'test'), null);
});

test('an error on a later page returns what it has rather than nothing', async () => {
  let n = 0;
  const build = () => ({
    range: (from, to) => {
      if (n++ === 0) {
        const rows = [];
        for (let i = from; i <= to; i++) rows.push({ id: i });
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'boom' } });
    },
  });
  const rows = await db.pagedSelect(build, 'test');
  assert.strictEqual(rows.length, 1000, 'a partial read is better than losing the page we got');
});

test('strict mode refuses a partial read', async () => {
  let n = 0;
  const build = () => ({
    range: (from, to) => {
      if (n++ === 0) {
        const rows = [];
        for (let i = from; i <= to; i++) rows.push({ id: i });
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'boom' } });
    },
  });
  // The measurement layer must fail loudly rather than report a confident
  // net edge computed on half the ledger.
  assert.strictEqual(await db.pagedSelect(build, 'test', { strict: true }), null);
});
