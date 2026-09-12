'use strict';
// 2026-09-12 — NFL injury-report CANDIDATES (weight 0).
//
// The headline test is `only one starting quarterback can be missing`. The
// first version summed QB designations, so Atlanta — with QB1 and QB3 both
// listed Out — read 2.00, treating a third-stringer's absence as a second
// franchise quarterback going down. That is the largest single feature in the
// batch, so an overstatement there would have dominated everything else.
//
// The second thing under test is that INJURED RESERVE and SUSPENSION are
// excluded. Both are known weeks ahead and already sit in the team's recent
// results, so counting them double-counts a fact the season stats contain.
const test = require('node:test');
const assert = require('node:assert');
const ni = require('../src/nfl-injuries');

const feed = (teams) => async () => ({
  ok: true,
  json: async () => ({
    injuries: Object.entries(teams).map(([displayName, list]) => ({
      displayName,
      injuries: list.map(([position, status]) => ({
        status, athlete: { position: { abbreviation: position } },
      })),
    })),
  }),
});

test('only one starting quarterback can be missing', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({ 'Atlanta Falcons': [['QB', 'Out'], ['QB', 'Out'], ['QB', 'Questionable']] }),
  });
  assert.strictEqual(inj.get('atlantafalcons').qbImpact, 1,
    'summing would give 2.35 and drown every other feature');
});

test('the worst QB designation wins, not the first seen', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({ 'Chicago Bears': [['QB', 'Questionable'], ['QB', 'Out']] }),
  });
  assert.strictEqual(inj.get('chicagobears').qbImpact, 1);
});

test('injured reserve, suspensions and active players are excluded', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({ 'Denver Broncos': [
      ['QB', 'Injured Reserve'], ['WR', 'Suspension'], ['RB', 'Active'],
    ] }),
  });
  const d = inj.get('denverbroncos');
  assert.strictEqual(d.weighted, 0, 'none of these is this week\'s news');
  assert.strictEqual(d.qbImpact, 0, 'a season-long IR QB is already in the season stats');
  assert.strictEqual(d.outCount, 0);
});

test('designation discounts: questionable counts far less than out', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({
      'A Team': [['WR', 'Out']],
      'B Team': [['WR', 'Questionable']],
    }),
  });
  assert.ok(inj.get('ateam').weighted > inj.get('bteam').weighted * 2,
    'questionable is close to a coin flip and must not read as an absence');
});

test('positive favours home: the AWAY team being hurt is good for home', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({ 'Home Team': [], 'Away Team': [['QB', 'Out']] }),
  });
  const f = ni.buildInjuryFeatures(inj, 'Home Team', 'Away Team');
  assert.strictEqual(f.nfl_qb_out_diff, 1, 'away QB out => positive');
  const flipped = ni.buildInjuryFeatures(inj, 'Away Team', 'Home Team');
  assert.strictEqual(flipped.nfl_qb_out_diff, -1);
});

test('position groups route correctly and do not overlap', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({ 'Home Team': [], 'Away Team': [['LT', 'Out'], ['CB', 'Out'], ['WR', 'Out']] }),
  });
  const f = ni.buildInjuryFeatures(inj, 'Home Team', 'Away Team');
  assert.ok(f.nfl_oline_out_diff > 0, 'LT is offensive line');
  assert.ok(f.nfl_secondary_out_diff > 0, 'CB is secondary');
  assert.ok(f.nfl_skill_out_diff > 0, 'WR is skill');
  assert.strictEqual(f.nfl_frontseven_out_diff, 0, 'none of those is front seven');
});

test('an unknown position still counts, at a default weight', async () => {
  const inj = await ni.fetchNflInjuries({
    fetch: feed({ 'Home Team': [], 'Away Team': [['XYZ', 'Out']] }),
  });
  assert.ok(inj.get('awayteam').weighted > 0, 'a new position abbreviation must not vanish');
});

test('a team missing from the feed omits features rather than claiming health', async () => {
  const inj = await ni.fetchNflInjuries({ fetch: feed({ 'Home Team': [] }) });
  assert.deepStrictEqual(ni.buildInjuryFeatures(inj, 'Home Team', 'Away Team'), {});
});

test('an HTTP failure yields an empty map, not a healthy league', async () => {
  const inj = await ni.fetchNflInjuries({ fetch: async () => ({ ok: false, status: 503 }) });
  assert.strictEqual(inj.size, 0);
  assert.deepStrictEqual(ni.buildInjuryFeatures(inj, 'A', 'B'), {});
});

test('values are clamped', async () => {
  const many = Array.from({ length: 40 }, () => ['WR', 'Out']);
  const inj = await ni.fetchNflInjuries({ fetch: feed({ 'Home Team': [], 'Away Team': many }) });
  const f = ni.buildInjuryFeatures(inj, 'Home Team', 'Away Team');
  for (const [k, v] of Object.entries(f)) assert.ok(Math.abs(v) <= ni.MAX_ABS, `${k}=${v}`);
});

test('every feature is declared at weight 0 in the shipped NFL config', () => {
  const cfg = require('../config/model-params.NFL.json');
  for (const [market, w] of Object.entries(cfg)) {
    if (!w || typeof w !== 'object' || !('nfl_qb_out_diff' in w)) continue;
    for (const n of ni.featureNames()) assert.strictEqual(w[n], 0, `${market}.${n}`);
  }
});
