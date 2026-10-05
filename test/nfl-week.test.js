'use strict';
// 2026-10-05 — the NFL lock window: Sunday evening locks all of next week.
const test = require('node:test');
const assert = require('node:assert');
const { nflLockHorizon } = require('../src/nfl-week');

// Wall-clock Pacific date string of the horizon, for readable assertions.
const ptDay = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
});

// Week 5 of 2026: TNF Thu 10/08, Sunday 10/11, MNF Mon 10/12 17:15 PT.
const TNF = Date.parse('2026-10-09T00:15:00Z');
const SUN_EARLY = Date.parse('2026-10-11T13:30:00Z');
const MNF = Date.parse('2026-10-13T00:15:00Z');
// Week 6 TNF, Thu 10/15.
const NEXT_TNF = Date.parse('2026-10-16T00:15:00Z');

test('Sunday ~7:50 PM PT run locks ALL of next week, Monday night included', () => {
  const sundayEvening = new Date('2026-10-05T02:50:00Z'); // Sun 10/04 19:50 PDT
  const h = nflLockHorizon(sundayEvening);
  for (const k of [TNF, SUN_EARLY, MNF]) assert.ok(k <= h, `kickoff ${ptDay(k)} should be inside ${ptDay(h)}`);
  assert.ok(NEXT_TNF > h, 'week 6 must wait for next Sunday');
  assert.match(ptDay(h), /Tue, 10\/13, 24|Tue, 10\/13, 00/);
});

test('the Sunday 5:30 AM run does not jump ahead to next week', () => {
  const sundayMorning = new Date('2026-10-04T12:30:00Z'); // Sun 10/04 05:30 PDT
  assert.ok(TNF > nflLockHorizon(sundayMorning));
});

test('Monday runs top up next week (odds posted late)', () => {
  const mondayMorning = new Date('2026-10-05T12:30:00Z'); // Mon 10/05 05:30 PDT
  const h = nflLockHorizon(mondayMorning);
  assert.ok(MNF <= h);
  assert.ok(NEXT_TNF > h);
});

test('Tuesday–Saturday runs never reach into next week', () => {
  for (const iso of ['2026-10-07T02:50:00Z', '2026-10-08T02:50:00Z', '2026-10-09T02:50:00Z', '2026-10-11T02:50:00Z']) {
    const h = nflLockHorizon(new Date(iso));
    assert.ok(MNF <= h, `${iso}: current week still covered`);
    assert.ok(NEXT_TNF > h, `${iso}: next Thursday must not lock a week early`);
  }
});

test('after the switch to standard time the Sunday run (~6:50 PM PST) still qualifies', () => {
  const h = nflLockHorizon(new Date('2026-11-09T02:50:00Z')); // Sun 11/08 18:50 PST
  assert.ok(Date.parse('2026-11-17T01:15:00Z') <= h, 'MNF 11/16 17:15 PST inside');
});
