'use strict';
const test = require('node:test');
const assert = require('node:assert');
const af = require('../src/arena-form');
const { normTeam } = require('../src/arena-context');

// n games newest first; day i ago, scores pf/pa, saves.
const games = (n, pf, pa, saves = null) => Array.from({ length: n }, (_, i) => ({
  when: new Date(Date.UTC(2026, 10, 10 - i * 2)).toISOString(), pf, pa, saves }));

test('NBA margin windows favour the hotter home team', () => {
  const form = new Map([
    [normTeam('Los Angeles Clippers'), games(12, 115, 105)],
    [normTeam('Sacramento Kings'), games(12, 100, 110)],
  ]);
  const f = af.buildArenaFormFeatures('NBA', form, 'Los Angeles Clippers', 'Sacramento Kings');
  assert.strictEqual(f.nba_margin_l5_diff, 2);      // (10 - -10) / 10
  assert.strictEqual(f.nba_margin_l10_diff, 2);
  assert.strictEqual(f.nba_margin_l5_surge_diff, 0); // flat form, no surge
  assert.strictEqual(f.nba_game_pts_l5_surge, 0);
  assert.ok(!('nhl_sv_l5_diff' in f));
});

test('too few games: features omitted, never zeroed', () => {
  const form = new Map([[normTeam('A'), games(4, 3, 2)], [normTeam('B'), games(12, 3, 2)]]);
  assert.deepStrictEqual(af.buildArenaFormFeatures('NHL', form, 'A', 'B'), {});
  const form2 = new Map([[normTeam('A'), games(6, 3, 2)], [normTeam('B'), games(6, 3, 2)]]);
  const f2 = af.buildArenaFormFeatures('NHL', form2, 'A', 'B');
  assert.ok('nhl_margin_l5_diff' in f2);
  assert.ok(!('nhl_margin_l10_diff' in f2) && !('nhl_margin_l5_surge_diff' in f2));
});

test('NHL team save % from saves and goals against; Montréal accent resolves', () => {
  const form = new Map([
    [normTeam('Montreal Canadiens'), games(12, 3, 2, 28)],  // 28/30 = .933
    [normTeam('Boston Bruins'), games(12, 2, 3, 27)],       // 27/30 = .900
  ]);
  const f = af.buildArenaFormFeatures('NHL', form, 'Montréal Canadiens', 'Boston Bruins');
  assert.ok(Math.abs(f.nhl_sv_l5_diff - (28 / 30 - 0.9) / 0.02) < 1e-9);
  assert.strictEqual(f.nhl_sv_l5_surge_diff, 0);
  assert.ok(Math.abs(f.nhl_margin_l5_diff - 2 / 1.5) < 1e-9);
});

test('missing saves: save-% features omitted', () => {
  const form = new Map([[normTeam('A'), games(12, 3, 2)], [normTeam('B'), games(12, 3, 2, 25)]]);
  const f = af.buildArenaFormFeatures('NHL', form, 'A', 'B');
  assert.ok(!('nhl_sv_l5_diff' in f) && 'nhl_margin_l5_diff' in f);
});

test('fetch keeps only completed regular-season games before the game date (PT)', async () => {
  const ev = (id, date, completed, type, hs, as_) => ({ id, date, season: { type },
    competitions: [{ status: { type: { completed } }, competitors: [
      { homeAway: 'home', score: String(hs), team: { displayName: 'Utah Mammoth' }, statistics: [{ name: 'saves', displayValue: '30' }] },
      { homeAway: 'away', score: String(as_), team: { displayName: 'Seattle Kraken' }, statistics: [{ name: 'saves', displayValue: '25' }] },
    ] }] });
  const events = [
    ev('1', '2026-11-08T02:00Z', true, 2, 4, 1),   // Nov 7 PT: counts
    ev('1', '2026-11-08T02:00Z', true, 2, 4, 1),   // duplicate id across days: once
    ev('3', '2026-11-10T03:00Z', false, 2, 1, 1),  // in progress: skipped
    ev('4', '2026-10-01T02:00Z', true, 1, 9, 0),   // preseason: skipped
    ev('5', '2026-11-11T03:00Z', true, 2, 2, 5),   // Nov 10 PT = game date: skipped
  ];
  af._dayCache.clear();
  // Serve the events on one day only; every other day is empty.
  const fetch = async (url) => ({ ok: true, json: async () => ({ events: url.endsWith('20261108') ? events : [] }) });
  const m = await af.fetchArenaForm('NHL', '2026-11-10', { fetch, lookbackDays: 3 });
  assert.strictEqual(m.get(normTeam('Utah Mammoth')).length, 1);
  assert.deepStrictEqual(m.get(normTeam('Seattle Kraken'))[0], { when: '2026-11-08T02:00Z', pf: 1, pa: 4, saves: 25 });
});

test('every emitted name is declared at weight 0 in all three markets', () => {
  for (const lg of ['NBA', 'NHL']) {
    const params = require(`../config/model-params.${lg}.json`);
    for (const mk of ['moneyline', 'spread', 'total']) {
      for (const n of af.featureNames(lg)) assert.strictEqual(params[mk][n], 0, `${lg} ${mk} ${n}`);
    }
  }
});
