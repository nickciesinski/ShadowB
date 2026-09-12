'use strict';
// 2026-09-11 — short-window team form, a batch of CANDIDATE features (weight 0).
//
// The headline test is `windows are anchored to the game date, not the clock`.
// Nick can only bet at ~9 PM PT the night before or ~5:30 AM PT the morning of,
// and he has ruled out picks that disagree with themselves between those two
// moments. A clock-anchored window resolved to 9/10 at 9 PM and 9/11 at 5:30 AM
// — same games, different inputs. Anchoring to the game date makes both agree.
const test = require('node:test');
const assert = require('node:assert');
const {
  windowFor, buildFormFeatures, fetchTeamWindow, featureNames, SPEC, MAX_ABS,
} = require('../src/form-windows');

test('windows are anchored to the game date, not the clock', () => {
  const a = windowFor('2026-09-12', 7);
  const b = windowFor('2026-09-12', 7);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.endDate, '2026-09-11');
  assert.strictEqual(a.startDate, '2026-09-05');
});

test('the window always ends BEFORE the game date — no in-progress results', () => {
  for (const gd of ['2026-04-01', '2026-07-04', '2026-09-12', '2026-11-02']) {
    const { endDate, startDate } = windowFor(gd, 7);
    assert.ok(endDate < gd, `${gd}: window must end before the games are played`);
    assert.ok(startDate < endDate, `${gd}: start must precede end`);
  }
});

test('positive favours home, and inverted stats are flipped', () => {
  const hitting = new Map([
    ['home', { ops: '.800', plateAppearances: 100, strikeOuts: 20, baseOnBalls: 10, runs: 10, homeRuns: 2, gamesPlayed: 2 }],
    ['away', { ops: '.700', plateAppearances: 100, strikeOuts: 20, baseOnBalls: 10, runs: 10, homeRuns: 2, gamesPlayed: 2 }],
  ]);
  const pitching = new Map([
    ['home', { era: '2.00', whip: '1.00', inningsPitched: '18.0', strikeOuts: 20, baseOnBalls: 5, homeRuns: 1 }],
    ['away', { era: '5.00', whip: '1.60', inningsPitched: '18.0', strikeOuts: 20, baseOnBalls: 5, homeRuns: 1 }],
  ]);
  const f = buildFormFeatures({ l7: { hitting, pitching } }, 'home', 'away');
  assert.ok(f.ops_l7_diff > 0, 'better home OPS => positive');
  assert.ok(f.era_l7_diff > 0, 'lower home ERA is BETTER => positive favours home');
  assert.ok(f.whip_l7_diff > 0, 'lower home WHIP => positive');
});

test('a missing team omits features rather than zeroing them', () => {
  const hitting = new Map([['home', { ops: '.800' }]]);
  const f = buildFormFeatures({ l7: { hitting, pitching: new Map() } }, 'home', 'away');
  assert.strictEqual(Object.keys(f).length, 0, '0 would assert the teams are equal');
});

test('values are clamped, so corruption cannot run to -5825', () => {
  const hitting = new Map([
    ['home', { ops: '99.000' }],
    ['away', { ops: '.001' }],
  ]);
  const f = buildFormFeatures({ l7: { hitting, pitching: new Map() } }, 'home', 'away');
  assert.strictEqual(f.ops_l7_diff, MAX_ABS);
});

test('unparseable stat strings are skipped, not read as 0', () => {
  const hitting = new Map([
    ['home', { ops: '.---' }],
    ['away', { ops: '.700' }],
  ]);
  const f = buildFormFeatures({ l7: { hitting, pitching: new Map() } }, 'home', 'away');
  assert.ok(!('ops_l7_diff' in f));
});

test('derived rates guard against divide-by-zero', () => {
  const hitting = new Map([
    ['home', { plateAppearances: 0, strikeOuts: 5, runs: 3, gamesPlayed: 0 }],
    ['away', { plateAppearances: 0, strikeOuts: 5, runs: 3, gamesPlayed: 0 }],
  ]);
  const f = buildFormFeatures({ l7: { hitting, pitching: new Map() } }, 'home', 'away');
  for (const k of Object.keys(f)) assert.ok(Number.isFinite(f[k]), `${k} must be finite`);
});

test('an HTTP failure yields an empty table, not a partial one', async () => {
  const t = await fetchTeamWindow('hitting', '2026-09-05', '2026-09-11',
    async () => ({ ok: false, status: 500 }));
  assert.strictEqual(t.size, 0);
});

test('every declared feature name is weighted 0 in the shipped config', () => {
  const cfg = require('../config/model-params.MLB.json');
  const names = featureNames();
  assert.strictEqual(names.length, SPEC.length * 2);
  for (const [market, w] of Object.entries(cfg)) {
    if (!w || typeof w !== 'object' || !('ops_l7_diff' in w)) continue;
    for (const n of names) {
      assert.strictEqual(w[n], 0, `${market}.${n} must be 0 — non-zero means it is being STAKED`);
    }
  }
});
