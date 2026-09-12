'use strict';
// 2026-09-11 — starting-pitcher and platoon CANDIDATES (weight 0).
//
// The headline test is `game logs never include the game being predicted`.
// Every one of these features is derived from completed games; if the date
// filter slipped, a starter's own line from tonight would be folded into the
// "recent form" that predicts tonight. That produces a spectacular backtest and
// no real edge, which is the failure mode that got umpire assignment dropped.
const test = require('node:test');
const assert = require('node:assert');
const mm = require('../src/mlb-matchup');

const okJson = (body) => async () => ({ ok: true, json: async () => body });

const gameLog = (dates) => ({
  stats: [{ splits: dates.map(([date, k, bb, ip, pitches]) => ({
    date, stat: { strikeOuts: k, baseOnBalls: bb, inningsPitched: String(ip), numberOfPitches: pitches },
  })) }],
});

test('game logs never include the game being predicted', async () => {
  const form = await mm.fetchStarterForm(1, '2026', '2026-09-12', okJson(gameLog([
    ['2026-09-01', 6, 1, 6, 90],
    ['2026-09-07', 8, 2, 7, 84],
    ['2026-09-12', 99, 0, 9, 120], // the game we are predicting — must be excluded
  ])));
  assert.strictEqual(form.lastPitches, 84, 'last start must be 9/07, not the 9/12 game');
  assert.strictEqual(form.daysRest, 5);
  assert.strictEqual(form.starts, 2, 'only completed starts count');
});

test('days rest is measured to the game date', async () => {
  const form = await mm.fetchStarterForm(1, '2026', '2026-09-12',
    okJson(gameLog([['2026-09-08', 5, 2, 5, 80]])));
  assert.strictEqual(form.daysRest, 4);
});

test('a pitcher with no prior starts yields null, not a default', async () => {
  assert.strictEqual(await mm.fetchStarterForm(1, '2026', '2026-09-12', okJson(gameLog([]))), null);
  // and a debut whose only log entry is today's game
  assert.strictEqual(
    await mm.fetchStarterForm(1, '2026', '2026-09-12', okJson(gameLog([['2026-09-12', 1, 1, 1, 20]]))),
    null);
});

test('positive favours home across every pitcher feature', () => {
  const ctx = {
    probables: { 'away@home': { home: { id: 1 }, away: { id: 2 } } },
    starters: new Map([
      [1, { daysRest: 6, lastPitches: 70, k9: 10, bb9: 1, ipPerStart: 7 }],
      [2, { daysRest: 4, lastPitches: 110, k9: 6, bb9: 4, ipPerStart: 5 }],
    ]),
    hands: new Map(), platoon: new Map(),
  };
  const f = mm.buildMatchupFeatures(ctx, 'home', 'away');
  assert.ok(f.starter_rest_diff > 0, 'more home rest => positive');
  assert.ok(f.starter_last_pitches_diff > 0, 'tired away starter => positive');
  assert.ok(f.starter_k9_l3_diff > 0, 'more home strikeouts => positive');
  assert.ok(f.starter_bb9_l3_diff > 0, 'fewer home walks => positive');
  assert.ok(f.starter_ip_l3_diff > 0, 'deeper home starts => positive');
});

test('platoon uses each lineup against the hand it actually faces', () => {
  const ctx = {
    probables: { 'away@home': { home: { id: 1 }, away: { id: 2 } } },
    starters: new Map(),
    hands: new Map([[1, 'L'], [2, 'R']]),          // home throws L, away throws R
    platoon: new Map([
      ['home', { L: 0.600, R: 0.800 }],            // home bats vs R (away's hand) = .800
      ['away', { L: 0.500, R: 0.900 }],            // away bats vs L (home's hand) = .500
    ]),
  };
  const f = mm.buildMatchupFeatures(ctx, 'home', 'away');
  // (.800 - .500) / 0.10 = 3.0
  assert.strictEqual(f.platoon_ops_diff, 3);
});

test('unknown handedness omits the platoon feature rather than guessing', () => {
  const ctx = {
    probables: { 'away@home': { home: { id: 1 }, away: { id: 2 } } },
    starters: new Map(),
    hands: new Map([[1, 'L']]),                    // away starter's hand unknown
    platoon: new Map([['home', { L: 0.6, R: 0.8 }], ['away', { L: 0.5, R: 0.9 }]]),
  };
  assert.ok(!('platoon_ops_diff' in mm.buildMatchupFeatures(ctx, 'home', 'away')));
});

test('a game with no probables produces nothing, not zeros', () => {
  const f = mm.buildMatchupFeatures(
    { probables: {}, starters: new Map(), hands: new Map(), platoon: new Map() }, 'home', 'away');
  assert.strictEqual(Object.keys(f).length, 0);
});

test('values are clamped', () => {
  const ctx = {
    probables: { 'away@home': { home: { id: 1 }, away: { id: 2 } } },
    starters: new Map([
      [1, { daysRest: 300, lastPitches: 0, k9: 99, bb9: 0, ipPerStart: 9 }],
      [2, { daysRest: 0, lastPitches: 999, k9: 0, bb9: 99, ipPerStart: 0 }],
    ]),
    hands: new Map(), platoon: new Map(),
  };
  const f = mm.buildMatchupFeatures(ctx, 'home', 'away');
  for (const [k, v] of Object.entries(f)) assert.ok(Math.abs(v) <= mm.MAX_ABS, `${k}=${v}`);
});

test('every feature is declared at weight 0 in the shipped config', () => {
  const cfg = require('../config/model-params.MLB.json');
  for (const [market, w] of Object.entries(cfg)) {
    if (!w || typeof w !== 'object' || !('platoon_ops_diff' in w)) continue;
    for (const n of mm.featureNames()) {
      assert.strictEqual(w[n], 0, `${market}.${n} must stay 0`);
    }
  }
});
