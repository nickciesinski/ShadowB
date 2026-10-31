'use strict';
// 2026-10-31 — the NFL lock window: each game locks the night before.
const test = require('node:test');
const assert = require('node:assert');
const { nflLockHorizon } = require('../src/nfl-week');

// Week 9 of 2026: TNF Thu 11/05, Sunday 11/08, MNF Mon 11/09 (PST).
const TNF = Date.parse('2026-11-06T01:15:00Z');
const SUN_EARLY = Date.parse('2026-11-08T18:00:00Z'); // 10 AM PST
const SUN_LATE = Date.parse('2026-11-08T21:25:00Z');
const SNF = Date.parse('2026-11-09T01:20:00Z');
const MNF = Date.parse('2026-11-10T01:15:00Z');

const at = (iso) => nflLockHorizon(new Date(iso));

test('Saturday ~7 PM PT run locks every Sunday game, not Monday night', () => {
  const h = at('2026-11-08T03:00:00Z'); // Sat 11/07 19:00 PST
  for (const k of [SUN_EARLY, SUN_LATE, SNF]) assert.ok(k <= h);
  assert.ok(MNF > h);
});

test('Saturday 5 AM PT top-up does not lock Sunday games', () => {
  assert.ok(SUN_EARLY > at('2026-11-07T13:00:00Z')); // Sat 05:00 PST
});

test('Sunday evening locks Monday night; Wednesday evening locks Thursday night', () => {
  assert.ok(MNF <= at('2026-11-09T03:00:00Z'));
  assert.ok(TNF <= at('2026-11-05T03:00:00Z'));
});

test('nothing locks a week ahead', () => {
  assert.ok(TNF > at('2026-11-02T03:00:00Z')); // previous Sunday evening
  assert.ok(SUN_EARLY > at('2026-11-06T03:00:00Z')); // Thursday evening
});

test('a missed Saturday build is covered by the Sunday 5 AM top-up', () => {
  const h = at('2026-11-08T13:00:00Z'); // Sun 05:00 PST
  for (const k of [SUN_EARLY, SUN_LATE, SNF]) assert.ok(k <= h);
});
