'use strict';
// 2026-09-10 — bullpen fatigue, a CANDIDATE feature (weight 0, stakes nothing).
//
// The headline test is `relief-only: a deep start must not read as a tired
// bullpen`. Total staff pitch count has the wrong sign built into it — a
// starter going eight innings is a lot of pitches and a RESTED pen — so
// counting everything would blend two opposite states into one number and the
// feature would measure noise no matter how it were weighted.
const test = require('node:test');
const assert = require('node:assert');
const { fetchBullpenLoad, bullpenFatigueDiff, normTeam, PITCHES_PER_UNIT } =
  require('../src/bullpen-fatigue');

const splits = (rows) => ({
  ok: true,
  json: async () => ({ stats: [{ splits: rows }] }),
});
const row = (team, pitches, gamesStarted, gamesPlayed = 1) => ({
  team: { name: team },
  stat: { numberOfPitches: pitches, gamesStarted, gamesPlayed },
});

test('relief-only: a deep start must not read as a tired bullpen', async () => {
  const load = await fetchBullpenLoad({
    fetch: async () => splits([
      row('Team A', 110, 1),  // starter — excluded
      row('Team A', 20, 0),   // reliever
      row('Team B', 15, 0),
      row('Team B', 18, 0),
    ]),
  });
  assert.strictEqual(load.get(normTeam('Team A')).reliefPitches, 20, 'starter pitches excluded');
  assert.strictEqual(load.get(normTeam('Team B')).reliefPitches, 33);
});

test('positive favours home, matching the house convention', () => {
  // More relief work is worse, so a tired AWAY pen is good for home.
  const load = new Map([
    [normTeam('Home'), { reliefPitches: 0, appearances: 0, team: 'Home' }],
    [normTeam('Away'), { reliefPitches: PITCHES_PER_UNIT, appearances: 0, team: 'Away' }],
  ]);
  assert.strictEqual(bullpenFatigueDiff(load, 'Home', 'Away'), 1,
    'tired away bullpen => positive => favours home');
  assert.strictEqual(bullpenFatigueDiff(load, 'Away', 'Home'), -1, 'and it inverts');
});

test('a missing team is null, not zero', () => {
  // 0 asserts "equally rested", which is a claim. Absent is the truth.
  const load = new Map([[normTeam('Home'), { reliefPitches: 10, appearances: 1, team: 'Home' }]]);
  assert.strictEqual(bullpenFatigueDiff(load, 'Home', 'Nobody'), null);
  assert.strictEqual(bullpenFatigueDiff(null, 'Home', 'Away'), null);
});

test('implausible values are clamped, like mlb_run_diff', () => {
  const load = new Map([
    [normTeam('H'), { reliefPitches: 0, appearances: 0, team: 'H' }],
    [normTeam('A'), { reliefPitches: 9999, appearances: 0, team: 'A' }],
  ]);
  assert.strictEqual(bullpenFatigueDiff(load, 'H', 'A'), 3);
});

test('team names normalise across feeds', () => {
  assert.strictEqual(normTeam('Athletics'), normTeam('athletics'));
  assert.strictEqual(normTeam('St. Louis Cardinals'), normTeam('St Louis Cardinals'));
});

test('an HTTP failure yields an empty table, never a partial one', async () => {
  const load = await fetchBullpenLoad({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.strictEqual(load.size, 0);
  // and the feature then reads absent rather than "everyone is rested"
  assert.strictEqual(bullpenFatigueDiff(load, 'A', 'B'), null);
});

test('a thrown fetch is caught and cannot break a slate', async () => {
  const load = await fetchBullpenLoad({ fetch: async () => { throw new Error('dns'); } });
  assert.strictEqual(load.size, 0);
});

test('it is declared at weight 0 in the shipped MLB config', () => {
  // If this ever becomes non-zero it is being STAKED, which must be a
  // deliberate commit after the forward sample earns it — not a drift.
  const cfg = require('../config/model-params.MLB.json');
  for (const [market, w] of Object.entries(cfg)) {
    if (w && typeof w === 'object' && 'bullpen_fatigue_diff' in w) {
      assert.strictEqual(w.bullpen_fatigue_diff, 0, `${market} must stay at weight 0`);
    }
  }
});
