'use strict';
// 2026-09-11 — NFL rest / travel / body-clock CANDIDATES (weight 0).
//
// The headline test is `every ESPN team name resolves to a venue`. normTeam
// strips digits, so "San Francisco 49ers" normalises to "sanfranciscoers" and a
// literal table key of "sanfrancisco49ers" silently never matched — one team
// quietly missing every travel feature, with no error anywhere. Keys are now
// normalised at load; this test is what keeps them that way.
const test = require('node:test');
const assert = require('node:assert');
const nc = require('../src/nfl-context');
const { normTeam } = require('../src/bullpen-fatigue');

// The real ESPN displayNames, so the test does not depend on the network.
const ESPN_NAMES = [
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills',
  'Carolina Panthers', 'Chicago Bears', 'Cincinnati Bengals', 'Cleveland Browns',
  'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs',
  'Las Vegas Raiders', 'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins',
  'Minnesota Vikings', 'New England Patriots', 'New Orleans Saints', 'New York Giants',
  'New York Jets', 'Philadelphia Eagles', 'Pittsburgh Steelers', 'San Francisco 49ers',
  'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Commanders',
];

test('every ESPN team name resolves to a venue', () => {
  const missing = ESPN_NAMES.filter((n) => !nc.venueFor(n));
  assert.deepStrictEqual(missing, [], 'a team with no venue silently loses every travel feature');
  assert.strictEqual(ESPN_NAMES.length, 32);
});

test('the 49ers specifically resolve, digits and all', () => {
  const v = nc.venueFor('San Francisco 49ers');
  assert.ok(v, 'normTeam strips digits — this is the case that broke');
  assert.strictEqual(v.tz, 'America/Los_Angeles');
  assert.strictEqual(normTeam('San Francisco 49ers'), 'sanfranciscoers');
});

test('shared-stadium teams agree on location', () => {
  for (const [a, b] of [['New York Giants', 'New York Jets'],
                        ['Los Angeles Rams', 'Los Angeles Chargers']]) {
    assert.deepStrictEqual(nc.venueFor(a), nc.venueFor(b), `${a} and ${b} share a stadium`);
  }
});

test('Arizona does not observe DST, and the table knows it', () => {
  const { tzOffsetHours } = require('../src/travel-context');
  const az = nc.venueFor('Arizona Cardinals').tz;
  assert.strictEqual(tzOffsetHours(az, '2026-07-01'), -7);
  assert.strictEqual(tzOffsetHours(az, '2026-12-01'), -7, 'Phoenix stays at -7 all year');
  // Indiana is the other trap.
  const ind = nc.venueFor('Indianapolis Colts').tz;
  assert.strictEqual(tzOffsetHours(ind, '2026-07-01'), -4);
});

const ctxOf = (prev) => ({ gameDate: '2026-09-13', previous: new Map(Object.entries(prev)) });

test('a short week counts against the team that had it', () => {
  const f = nc.buildNflFeatures(ctxOf({
    [normTeam('Chicago Bears')]: { when: '2026-09-07T17:00Z', venueTeam: 'Chicago Bears' },
    [normTeam('Green Bay Packers')]: { when: '2026-09-10T00:20Z', venueTeam: 'Green Bay Packers' },
  }), 'Chicago Bears', 'Green Bay Packers', '2026-09-13T17:00Z');
  assert.ok(f.nfl_rest_days_diff > 0, 'home rested longer => positive');
  assert.strictEqual(f.nfl_short_week_diff, 1, 'away on a short week favours home');
});

test('coming off a bye favours the rested team', () => {
  const f = nc.buildNflFeatures(ctxOf({
    [normTeam('Chicago Bears')]: { when: '2026-08-30T17:00Z', venueTeam: 'Chicago Bears' },
    [normTeam('Green Bay Packers')]: { when: '2026-09-07T17:00Z', venueTeam: 'Green Bay Packers' },
  }), 'Chicago Bears', 'Green Bay Packers', '2026-09-13T17:00Z');
  assert.strictEqual(f.nfl_off_bye_diff, 1, 'home had >10 days, away did not');
});

test('eastward travel favours the home team', () => {
  const f = nc.buildNflFeatures(ctxOf({}), 'Buffalo Bills', 'Seattle Seahawks');
  assert.ok(f.nfl_tz_shift_diff > 0, 'Seattle at Buffalo: away loses 3 hours');
  const back = nc.buildNflFeatures(ctxOf({}), 'Seattle Seahawks', 'Buffalo Bills');
  assert.ok(back.nfl_tz_shift_diff < 0);
});

test('travel is measured from the previous game venue', () => {
  const f = nc.buildNflFeatures(ctxOf({
    [normTeam('Seattle Seahawks')]: { when: '2026-09-07T17:00Z', venueTeam: 'Miami Dolphins' },
    [normTeam('Buffalo Bills')]: { when: '2026-09-07T17:00Z', venueTeam: 'Buffalo Bills' },
  }), 'Buffalo Bills', 'Seattle Seahawks', '2026-09-13T17:00Z');
  assert.ok(f.nfl_travel_miles_diff > 0, 'away came from Miami, home stayed put');
});

test('missing inputs omit features rather than asserting zero', () => {
  const f = nc.buildNflFeatures(ctxOf({}), 'Buffalo Bills', 'Seattle Seahawks');
  assert.ok(!('nfl_rest_days_diff' in f));
  assert.ok(!('nfl_travel_miles_diff' in f));
  assert.deepStrictEqual(nc.buildNflFeatures(ctxOf({}), 'Not A Team', 'Seattle Seahawks'), {});
});

test('every feature is declared at weight 0 in the shipped NFL config', () => {
  const cfg = require('../config/model-params.NFL.json');
  for (const [market, w] of Object.entries(cfg)) {
    if (!w || typeof w !== 'object' || !('nfl_rest_days_diff' in w)) continue;
    for (const n of nc.featureNames()) assert.strictEqual(w[n], 0, `${market}.${n}`);
  }
});
