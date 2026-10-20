'use strict';
// 2026-10-20 — NFL short-window form CANDIDATES (weight 0). See src/nfl-form.js.
//
// The tests that matter most here are about timing and stability, not maths:
// a game in progress must never count, a game on the slate date must never
// count, and the weights must stay 0 so no pick can move.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const nf = require('../src/nfl-form');

// A minimal ESPN week payload.
function ev(date, home, hs, away, as, { completed = true, type = 2 } = {}) {
  return {
    date, season: { type },
    competitions: [{
      status: { type: { completed } },
      competitors: [
        { homeAway: 'home', team: { displayName: home }, score: String(hs) },
        { homeAway: 'away', team: { displayName: away }, score: String(as) },
      ],
    }],
  };
}

function fakeFetch(weeks) {
  return async (url) => {
    const w = Number(/week=(\d+)/.exec(url)[1]);
    return { ok: true, json: async () => ({ events: weeks[w] || [] }) };
  };
}

const WEEKS = {
  1: [ev('2026-09-13T17:00Z', 'Chicago Bears', 10, 'Detroit Lions', 30)],
  2: [ev('2026-09-20T17:00Z', 'Detroit Lions', 24, 'Chicago Bears', 20)],
  3: [ev('2026-09-27T17:00Z', 'Chicago Bears', 31, 'Detroit Lions', 17)],
  4: [ev('2026-10-04T17:00Z', 'Detroit Lions', 14, 'Chicago Bears', 28)],
  // Thursday night game, still in progress at build time: must be ignored.
  5: [ev('2026-10-09T00:15Z', 'Chicago Bears', 7, 'Detroit Lions', 3, { completed: false })],
  // The game being predicted, already final: must be ignored (same date).
  6: [ev('2026-10-18T17:00Z', 'Chicago Bears', 50, 'Detroit Lions', 0)],
};

test('only completed games strictly before the game date count', async () => {
  nf._weekCache.clear();
  const form = await nf.fetchNflForm('2026-10-18', { fetch: fakeFetch(WEEKS) });
  const bears = form.get('chicagobears');
  assert.strictEqual(bears.length, 4, 'in-progress and same-day games are excluded');
  assert.deepStrictEqual(bears.map((g) => g.pf), [28, 31, 20, 10], 'newest first');
});

test('preseason games never count', async () => {
  nf._weekCache.clear();
  const form = await nf.fetchNflForm('2026-10-18', { fetch: fakeFetch({
    1: [ev('2026-08-20T00:00Z', 'Chicago Bears', 40, 'Detroit Lions', 0, { type: 1 })],
  }) });
  assert.strictEqual(form.size, 0);
});

test('a Sunday-evening ET kickoff is dated by its Pacific day', () => {
  // 00:20 UTC Monday is 5:20 PM PT Sunday.
  assert.strictEqual(nf.ptDate('2026-10-19T00:20Z'), '2026-10-18');
});

test('features: positive favours home, values as expected', async () => {
  nf._weekCache.clear();
  const form = await nf.fetchNflForm('2026-10-18', { fetch: fakeFetch(WEEKS) });
  const f = nf.buildNflFormFeatures(form, 'Chicago Bears', 'Detroit Lions');
  // Bears last 3: +14, +14, -4 => +8 margin. Lions: -14, -14, +4 => -8.
  assert.ok(Math.abs(f.nfl_margin_l3_diff - 1.6) < 1e-9);
  // Bears points allowed L3 avg 18.67, Lions 26.33 => favours Bears (home).
  assert.ok(f.nfl_pa_l3_diff > 0);
  // Season (4 games): Bears -20,-4,+14,+14 = +1; Lions -1. Surge = (8-1) - (-8+1) = 14 => 1.4.
  assert.ok(Math.abs(f.nfl_margin_l3_surge_diff - 1.4) < 1e-9);
  assert.ok('nfl_game_pts_l3_surge' in f);
  for (const k of Object.keys(f)) assert.ok(nf.featureNames().includes(k), `${k} is declared`);
});

test('too few games: omitted, never zeroed', () => {
  const form = new Map([
    ['chicagobears', [{ pf: 10, pa: 3 }, { pf: 10, pa: 3 }]],
    ['detroitlions', [{ pf: 10, pa: 3 }, { pf: 10, pa: 3 }, { pf: 10, pa: 3 }]],
  ]);
  assert.deepStrictEqual(nf.buildNflFormFeatures(form, 'Chicago Bears', 'Detroit Lions'), {});
});

test('surge features need history beyond the 3-game window', () => {
  const g = { pf: 20, pa: 10 };
  const form = new Map([['chicagobears', [g, g, g]], ['detroitlions', [g, g, g]]]);
  const f = nf.buildNflFormFeatures(form, 'Chicago Bears', 'Detroit Lions');
  assert.ok('nfl_margin_l3_diff' in f);
  assert.ok(!('nfl_margin_l3_surge_diff' in f), 'L3 minus a 3-game season is L3 minus itself');
});

test('same inputs, same values: 9 PM and 5:30 AM builds agree', async () => {
  nf._weekCache.clear();
  const a = await nf.fetchNflForm('2026-10-18', { fetch: fakeFetch(WEEKS) });
  nf._weekCache.clear();
  const b = await nf.fetchNflForm('2026-10-18', { fetch: fakeFetch(WEEKS) });
  assert.deepStrictEqual(
    nf.buildNflFormFeatures(a, 'Chicago Bears', 'Detroit Lions'),
    nf.buildNflFormFeatures(b, 'Chicago Bears', 'Detroit Lions'));
});

test('every new feature is declared at weight 0 in every NFL market', () => {
  const params = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'model-params.NFL.json'), 'utf8'));
  for (const m of ['moneyline', 'spread', 'total']) {
    for (const k of nf.featureNames()) {
      assert.strictEqual(params[m][k], 0, `${m}.${k} must be 0 — a candidate moves no pick`);
    }
  }
});

test('reaches extractFeatures, and logs as a candidate without moving the score', () => {
  const { extractFeatures, decomposeScore } = require('../src/game-features');
  const g = { pf: 27, pa: 13 };
  const b = { pf: 13, pa: 27 };
  const nflForm = new Map([['chicagobears', [g, g, g, b]], ['detroitlions', [b, b, b, g]]]);
  const base = { homeTeam: 'Chicago Bears', awayTeam: 'Detroit Lions' };
  const withForm = extractFeatures({}, {}, null, 'NFL', { ...base, nflForm });
  const without = extractFeatures({}, {}, null, 'NFL', base);
  assert.ok('nfl_margin_l3_diff' in withForm);
  assert.ok(!('nfl_margin_l3_diff' in without));

  const params = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'model-params.NFL.json'), 'utf8'));
  const live = (fv) => decomposeScore(fv, params.moneyline)
    .reduce((s, c) => s + c.contribution, 0);
  assert.strictEqual(live(withForm), live(without), 'the pick cannot move');
  const logged = decomposeScore(withForm, params.moneyline, { includeCandidates: true })
    .filter((c) => c.candidate).map((c) => c.feature);
  assert.ok(logged.includes('nfl_margin_l3_diff'), 'but it is recorded for the CLV report');
});
