'use strict';
// test/season-guard.test.js — season-windows + zero-data-guard + pitcher remap.
// All pure logic; no network or Sheets required.

const { test } = require('node:test');
const assert = require('node:assert');

const sw = require('../src/season-windows');
const { evaluateGradedCoverage, collectZeroDataAlerts } = require('../src/zero-data-guard');
const { remapStarterMapToGames } = require('../src/pitcher-data');

// Use the real config file — these assertions double as a sanity check
// that config/season-windows.json encodes the actual league calendars.
const d = (y, m, day) => new Date(y, m - 1, day);

test('MLB window: in season mid-July, offseason in January', () => {
  assert.strictEqual(sw.isInSeason('MLB', d(2026, 7, 9)), true);
  assert.strictEqual(sw.isInSeason('MLB', d(2026, 1, 15)), false);
  assert.strictEqual(sw.isInSeason('MLB', d(2026, 12, 1)), false);
});

test('NHL wrap window: offseason in July, in season Nov and Feb and April', () => {
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 7, 9)), false);
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 11, 15)), true);
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 2, 15)), true);
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 4, 20)), true);
});

test('NFL wrap window: Sep-Feb in, July out', () => {
  assert.strictEqual(sw.isInSeason('NFL', d(2026, 9, 15)), true);
  assert.strictEqual(sw.isInSeason('NFL', d(2027, 1, 20)), true);
  assert.strictEqual(sw.isInSeason('NFL', d(2026, 7, 9)), false);
});

test('boundary days are inclusive', () => {
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 10, 1)), true);   // start day
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 6, 30)), true);   // end day
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 7, 1)), false);   // day after end
  assert.strictEqual(sw.isInSeason('NHL', d(2026, 9, 30)), false);  // day before start
});

test('unknown league fails OPEN (in season) — never silence an unconfigured league', () => {
  assert.strictEqual(sw.isInSeason('XFL', d(2026, 7, 9)), true);
});

test('leaguesInSeason on July 9 2026 = MLB only', () => {
  assert.deepStrictEqual(sw.leaguesInSeason(d(2026, 7, 9)), ['MLB']);
});

test('daysSinceSeasonStart: null offseason, correct across year wrap', () => {
  assert.strictEqual(sw.daysSinceSeasonStart('NHL', d(2026, 7, 9)), null);
  assert.strictEqual(sw.daysSinceSeasonStart('NHL', d(2026, 10, 4)), 3);   // Oct 1 start
  // Feb 15 2027 vs Oct 1 2026 start = 137 days (Oct 30 + Nov 30 + Dec 31 + Jan 31 + Feb 15)
  assert.strictEqual(sw.daysSinceSeasonStart('NHL', d(2027, 2, 15)), 137);
});

test('seasonStartWithin flags the opening week only', () => {
  assert.strictEqual(sw.seasonStartWithin('NHL', d(2026, 10, 3), 7), true);
  assert.strictEqual(sw.seasonStartWithin('NHL', d(2026, 10, 20), 7), false);
  assert.strictEqual(sw.seasonStartWithin('NHL', d(2026, 7, 9), 7), false); // offseason
});

// ── zero-data-guard ──────────────────────────────────────────────

test('zero graded picks in-season → ALERT', () => {
  const res = evaluateGradedCoverage({ league: 'MLB', gradedCount: 0, now: d(2026, 7, 9), windowDays: 7 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.alert, true);
  assert.match(res.reason, /in season but 0 graded/);
});

test('zero graded picks offseason → silent OK', () => {
  const res = evaluateGradedCoverage({ league: 'NHL', gradedCount: 0, now: d(2026, 7, 9) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.alert, false);
  assert.strictEqual(res.reason, 'offseason');
});

test('grace period: 0 graded on day 1-2 of a season does not alert', () => {
  const res = evaluateGradedCoverage({ league: 'NHL', gradedCount: 0, now: d(2026, 10, 2), minSeasonDays: 3 });
  assert.strictEqual(res.alert, false);
  const after = evaluateGradedCoverage({ league: 'NHL', gradedCount: 0, now: d(2026, 10, 6), minSeasonDays: 3 });
  assert.strictEqual(after.alert, true, 'past the grace period, zero data must alert');
});

test('nonzero graded picks → OK', () => {
  const res = evaluateGradedCoverage({ league: 'MLB', gradedCount: 42, now: d(2026, 7, 9) });
  assert.strictEqual(res.ok, true);
});

test('collectZeroDataAlerts: mixed map on July 9 → only MLB alerts', () => {
  const alerts = collectZeroDataAlerts(
    { MLB: 0, NBA: 0, NHL: 0, NFL: 0 },
    { now: d(2026, 7, 9), windowDays: 14 }
  );
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].league, 'MLB');
});

test('collectZeroDataAlerts: November with all leagues live and dead pipeline → 4 alerts', () => {
  const alerts = collectZeroDataAlerts(
    { MLB: 5, NBA: 0, NHL: 0, NFL: 0 },
    { now: d(2026, 11, 10), windowDays: 7 }
  );
  // MLB has data; NBA/NHL/NFL are all in season on Nov 10 with zero → 3 alerts
  assert.deepStrictEqual(alerts.map(a => a.league).sort(), ['NBA', 'NFL', 'NHL']);
});

// ── pitcher-data remap ───────────────────────────────────────────

test('remapStarterMapToGames: exact names hit, punctuation drift hits, misses drop', () => {
  const espnMap = new Map([
    ['St. Louis Cardinals@Chicago Cubs', { pitcherAdj: 0.5 }],   // punctuation differs from odds names
    ['New York Yankees@Boston Red Sox', { pitcherAdj: -0.3 }],   // exact match
    ['Ghost Team@Nowhere FC', { pitcherAdj: 9 }],                // no matching game
  ]);
  const games = [
    { away: 'St Louis Cardinals', home: 'Chicago Cubs' },
    { away: 'New York Yankees', home: 'Boston Red Sox' },
    { away: 'Los Angeles Dodgers', home: 'San Diego Padres' },   // no ESPN entry
  ];
  const out = remapStarterMapToGames(espnMap, games);
  assert.strictEqual(out.size, 2);
  assert.strictEqual(out.get('St Louis Cardinals@Chicago Cubs').pitcherAdj, 0.5,
    'output must be keyed by the GAME names so game-model lookups always hit');
  assert.strictEqual(out.get('New York Yankees@Boston Red Sox').pitcherAdj, -0.3);
  assert.strictEqual(out.get('Los Angeles Dodgers@San Diego Padres'), undefined);
});

test('remapStarterMapToGames tolerates empty inputs', () => {
  assert.strictEqual(remapStarterMapToGames(new Map(), []).size, 0);
  assert.strictEqual(remapStarterMapToGames(new Map(), null).size, 0);
});
