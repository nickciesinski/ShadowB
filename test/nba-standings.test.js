'use strict';
// 2026-10-01 — NBA records and points allowed from standings, blended so one
// game is not read as a season.
const test = require('node:test');
const assert = require('node:assert');
const { blendNbaTeam, nbaSeasonYear } = require('../src/data-collection');
const last = { wins: 56, losses: 26, avgPointsFor: 114.85, avgPointsAgainst: 107.16 };

test('before a team plays, last season is used as-is', () => {
  const b = blendNbaTeam({ wins: 0, losses: 0, avgPointsFor: 0, avgPointsAgainst: 0 }, last);
  assert.ok(Math.abs(b.pct - 56 / 82) < 1e-9);
  assert.ok(Math.abs(b.pointsAgainst - 107.16) < 1e-9);
});

test('one blowout loss barely moves the team', () => {
  const b = blendNbaTeam({ wins: 0, losses: 1, avgPointsFor: 90, avgPointsAgainst: 140 }, last);
  assert.ok(b.pct > 0.6, `pct ${b.pct}`);
  assert.ok(b.pointsAgainst < 112, `PA ${b.pointsAgainst}`);
});

test('no data at all is null, never zeros', () => {
  assert.strictEqual(blendNbaTeam(undefined, undefined), null);
});

test('season label is the year the season ends', () => {
  assert.strictEqual(nbaSeasonYear(new Date('2026-10-20T00:00:00Z')), 2027);
  assert.strictEqual(nbaSeasonYear(new Date('2027-03-01T00:00:00Z')), 2027);
});
