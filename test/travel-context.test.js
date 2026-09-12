'use strict';
// 2026-09-11 — travel, body clock and rest CANDIDATES (weight 0).
//
// The headline test is `eastward travel favours the home team`. An earlier
// version of this file negated the shift and reported a jet-lagged away team as
// an ADVANTAGE to that team — exactly backwards, and invisible at runtime since
// the feature carries weight 0 and would simply have logged a confident wrong
// sign for weeks.
const test = require('node:test');
const assert = require('node:assert');
const tc = require('../src/travel-context');

const SEA = { lat: 47.591, lon: -122.332, tz: 'America/Los_Angeles' };
const NYY = { lat: 40.829, lon: -73.926, tz: 'America/New_York' };
const ctxOf = (prev = {}) => ({
  gameDate: '2026-09-12',
  homes: new Map([['sea', SEA], ['nyy', NYY]]),
  previous: new Map(Object.entries(prev)),
});

test('eastward travel favours the home team', () => {
  const f = tc.buildTravelFeatures(ctxOf(), 'nyy', 'sea');
  assert.ok(f.away_tz_shift_diff > 0, 'Seattle at New York: away loses hours => favours home');
  const back = tc.buildTravelFeatures(ctxOf(), 'sea', 'nyy');
  assert.ok(back.away_tz_shift_diff < 0, 'and westward travel is the easier direction');
  assert.strictEqual(f.away_tz_shift_diff, -back.away_tz_shift_diff, 'symmetric');
});

test('timezone offsets are DST-correct', () => {
  // A hard-coded table would mis-state every game after the November change.
  assert.strictEqual(tc.tzOffsetHours('America/Los_Angeles', '2026-09-12'), -7);
  assert.strictEqual(tc.tzOffsetHours('America/Los_Angeles', '2026-12-12'), -8);
  assert.strictEqual(tc.tzOffsetHours('America/New_York', '2026-09-12'), -4);
  assert.strictEqual(tc.tzOffsetHours('Not/AZone', '2026-09-12'), null);
});

test('great-circle distance is right', () => {
  const miles = tc.haversineMiles({ lat: 33.94, lon: -118.41 }, { lat: 40.64, lon: -73.78 });
  assert.ok(Math.abs(miles - 2475) < 30, `LAX->JFK ~2475, got ${miles}`);
  assert.strictEqual(tc.haversineMiles(null, NYY), null);
});

test('travel is measured from the PREVIOUS GAME, not the home park', () => {
  // Seattle already in New York for game 2 of a series has NOT just flown
  // cross-country. Using the home park would claim ~2400 miles of travel.
  const f = tc.buildTravelFeatures(ctxOf({
    sea: { lat: NYY.lat, lon: NYY.lon, when: '2026-09-11T23:00:00Z' },
    nyy: { lat: NYY.lat, lon: NYY.lon, when: '2026-09-11T23:00:00Z' },
  }), 'nyy', 'sea');
  assert.strictEqual(f.travel_miles_diff, 0, 'nobody travelled between games');
});

test('a real flight shows up as travel against the away team', () => {
  const f = tc.buildTravelFeatures(ctxOf({
    sea: { lat: SEA.lat, lon: SEA.lon, when: '2026-09-11T02:00:00Z' }, // was home
    nyy: { lat: NYY.lat, lon: NYY.lon, when: '2026-09-11T23:00:00Z' },
  }), 'nyy', 'sea');
  assert.ok(f.travel_miles_diff > 1, 'away flew ~2400 miles, home did not');
});

test('rest is in hours, and a getaway day reads shorter than a day off', () => {
  const f = tc.buildTravelFeatures(ctxOf({
    nyy: { lat: NYY.lat, lon: NYY.lon, when: '2026-09-11T23:00:00Z' }, // ~17h
    sea: { lat: NYY.lat, lon: NYY.lon, when: '2026-09-10T23:00:00Z' }, // ~41h
  }), 'nyy', 'sea', '2026-09-12T16:00:00Z');
  assert.ok(f.rest_hours_diff < 0, 'home had LESS rest => negative');
});

test('missing inputs omit features rather than asserting zero travel', () => {
  const f = tc.buildTravelFeatures(ctxOf(), 'nyy', 'sea');
  assert.ok(!('travel_miles_diff' in f), 'no previous game => no travel claim');
  assert.ok(!('rest_hours_diff' in f), 'no commence time => no rest claim');
  assert.deepStrictEqual(tc.buildTravelFeatures(null, 'nyy', 'sea'), {});
  // an unknown home venue means we do not know where the game even is
  assert.deepStrictEqual(tc.buildTravelFeatures(ctxOf(), 'unknown', 'sea'), {});
});

test('values are clamped', () => {
  const far = { lat: -33.87, lon: 151.21, tz: 'Australia/Sydney' };
  const ctx = { gameDate: '2026-09-12', homes: new Map([['nyy', NYY], ['far', far]]),
                previous: new Map([['far', { lat: far.lat, lon: far.lon, when: '2026-09-11T00:00:00Z' }],
                                   ['nyy', { lat: NYY.lat, lon: NYY.lon, when: '2026-09-11T23:00:00Z' }]]) };
  const f = tc.buildTravelFeatures(ctx, 'nyy', 'far', '2026-09-12T23:00:00Z');
  for (const [k, v] of Object.entries(f)) assert.ok(Math.abs(v) <= tc.MAX_ABS, `${k}=${v}`);
});

test('every feature is declared at weight 0 in the shipped config', () => {
  const cfg = require('../config/model-params.MLB.json');
  for (const [market, w] of Object.entries(cfg)) {
    if (!w || typeof w !== 'object' || !('travel_miles_diff' in w)) continue;
    for (const n of tc.featureNames()) assert.strictEqual(w[n], 0, `${market}.${n}`);
  }
});
