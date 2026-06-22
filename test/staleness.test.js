'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateRecency, STALE_MAX_AGE_DAYS } = require('../src/staleness');

// Fixed reference "now" so age math is deterministic.
const NOW = Date.parse('2026-06-22T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString(); // full ISO -> exact integer ages

test('fresh dual-write (same day) is OK', () => {
  const r = evaluateRecency({ rows: [{ date: daysAgo(0) }], nowMs: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, undefined);
  assert.ok(r.ageDays >= 0 && r.ageDays <= 1);
});

test('exactly at the 2-day threshold is still OK (boundary: only > maxAge is stale)', () => {
  const r = evaluateRecency({ rows: [{ date: daysAgo(2) }], nowMs: NOW });
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.ageDays - 2) < 1e-9);
});

test('STALE alert FIRES when data is older than the threshold', () => {
  const r = evaluateRecency({ rows: [{ date: daysAgo(3) }], nowMs: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'stale');
  assert.ok(r.ageDays > STALE_MAX_AGE_DAYS);
});

test('STALE fires for the real 41-day outage scenario', () => {
  const r = evaluateRecency({ rows: [{ date: daysAgo(41) }], nowMs: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'stale');
  assert.ok(Math.abs(r.ageDays - 41) < 1e-9);
});

test('empty table is not OK (empty_table)', () => {
  for (const rows of [[], null, undefined]) {
    const r = evaluateRecency({ rows, nowMs: NOW });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'empty_table');
  }
});

test('custom maxAgeDays is honored', () => {
  // 5 days old: stale at default 2, fresh at maxAgeDays=7
  assert.strictEqual(evaluateRecency({ rows: [{ date: daysAgo(5) }], nowMs: NOW }).ok, false);
  assert.strictEqual(evaluateRecency({ rows: [{ date: daysAgo(5) }], nowMs: NOW, maxAgeDays: 7 }).ok, true);
});

test('default threshold constant is 2 days', () => {
  assert.strictEqual(STALE_MAX_AGE_DAYS, 2);
});
