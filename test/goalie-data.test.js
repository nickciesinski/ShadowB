'use strict';
// test/goalie-data.test.js — synthetic validation of the NHL starting-goalie
// adjustment. No network or Sheets access needed; NHL is offseason at write
// time (2026-07-09) so real-data validation happens in October — these tests
// pin the math, sign convention, caps, and graceful degradation until then.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  computeGoalieAdj,
  computeGoalieTotalAdj,
  extractGoalieFromProbables,
  pickPresumedStarter,
  goalieGoalsVsAvg,
  normalizeSvPct,
  normalizeGaa,
  normTeam,
  NHL_AVG_SVPCT,
  NHL_SHOTS_PER_GAME,
  MARGIN_ADJ_CAP,
  TOTAL_ADJ_CAP,
  PRESUMED_DAMPEN,
} = require('../src/goalie-data');

// Handy fixtures — confirmed starters unless noted
const elite = { name: 'Elite Goalie', savePct: 0.925, confirmed: true };   // +.025 over avg
const average = { name: 'Avg Goalie', savePct: 0.900, confirmed: true };
const weak = { name: 'Weak Goalie', savePct: 0.880, confirmed: true };     // -.020 under avg

test('normalizeSvPct handles decimal, percent, string, and garbage forms', () => {
  assert.strictEqual(normalizeSvPct(0.912), 0.912);
  assert.strictEqual(normalizeSvPct('.912'), 0.912);
  assert.strictEqual(normalizeSvPct(91.2), 0.912);
  assert.strictEqual(normalizeSvPct('91.2'), 0.912);
  assert.strictEqual(normalizeSvPct(''), null);
  assert.strictEqual(normalizeSvPct(null), null);
  assert.strictEqual(normalizeSvPct('N/A'), null);
  assert.strictEqual(normalizeSvPct(-5), null);
  assert.strictEqual(normalizeSvPct(250), null); // out of any sane range
});

test('normalizeGaa gates to a sane range', () => {
  assert.strictEqual(normalizeGaa(2.45), 2.45);
  assert.strictEqual(normalizeGaa('2.45'), 2.45);
  assert.strictEqual(normalizeGaa(0.1), null);  // implausible
  assert.strictEqual(normalizeGaa(12), null);   // implausible
  assert.strictEqual(normalizeGaa(''), null);
});

test('normTeam makes punctuation-variant names match (Odds API vs ESPN)', () => {
  assert.strictEqual(normTeam('St. Louis Blues'), normTeam('St Louis Blues'));
  assert.strictEqual(normTeam('Montréal Canadiens') === normTeam('Montreal Canadiens'), false,
    'accented chars differ — documents the known limitation, fuzzier matching not needed for NHL Odds API names');
  assert.strictEqual(normTeam('Toronto Maple Leafs'), 'torontomapleleafs');
});

test('sign convention: home better goalie → POSITIVE adj (matches pitcherAdj)', () => {
  const adj = computeGoalieAdj(elite, weak);
  assert.ok(adj > 0, `expected positive, got ${adj}`);
  const flipped = computeGoalieAdj(weak, elite);
  assert.ok(flipped < 0, `expected negative, got ${flipped}`);
  // Symmetric
  assert.ok(Math.abs(adj + flipped) < 1e-9);
});

test('magnitude sanity: .925 vs .880 ≈ 0.045 × 28.5 shots, hits the ±0.75 cap', () => {
  // Raw diff = 28.5 × 0.045 ≈ 1.28 goals → capped at 0.75
  const adj = computeGoalieAdj(elite, weak);
  assert.strictEqual(adj, MARGIN_ADJ_CAP);
});

test('moderate quality gap stays under the cap', () => {
  const good = { name: 'G', savePct: 0.910, confirmed: true };
  const adj = computeGoalieAdj(good, average);
  const expected = NHL_SHOTS_PER_GAME * (0.910 - NHL_AVG_SVPCT); // ≈ 0.285
  assert.ok(Math.abs(adj - expected) < 1e-9);
  assert.ok(adj < MARGIN_ADJ_CAP);
});

test('both average goalies → 0 adjustment', () => {
  assert.strictEqual(computeGoalieAdj(average, { ...average }), 0);
});

test('missing goalies contribute 0 — never guess', () => {
  assert.strictEqual(computeGoalieAdj(null, null), 0);
  assert.strictEqual(goalieGoalsVsAvg(null), 0);
  assert.strictEqual(goalieGoalsVsAvg({ name: 'No Stats', confirmed: true }), 0);
  // One side known, other unknown: adjustment reflects only the known side
  const adj = computeGoalieAdj(elite, null);
  assert.ok(adj > 0);
});

test('presumed (unconfirmed) starters are dampened by PRESUMED_DAMPEN', () => {
  const confirmed = goalieGoalsVsAvg({ savePct: 0.915, confirmed: true });
  const presumed = goalieGoalsVsAvg({ savePct: 0.915, confirmed: false });
  assert.ok(Math.abs(presumed - confirmed * PRESUMED_DAMPEN) < 1e-9);
});

test('GAA fallback used only when SV% missing, at half trust, lower GAA = better', () => {
  const svBased = goalieGoalsVsAvg({ savePct: 0.915, gaa: 2.2, confirmed: true });
  const svOnly = goalieGoalsVsAvg({ savePct: 0.915, confirmed: true });
  assert.strictEqual(svBased, svOnly, 'SV% must take precedence over GAA');

  const gaaGood = goalieGoalsVsAvg({ gaa: 2.40, confirmed: true }); // below 2.90 avg → positive
  const gaaBad = goalieGoalsVsAvg({ gaa: 3.40, confirmed: true });
  assert.ok(gaaGood > 0 && gaaBad < 0);
});

test('totals: two elite goalies → negative (lower total); two weak → positive; capped', () => {
  const lowTotal = computeGoalieTotalAdj(elite, { ...elite });
  assert.ok(lowTotal < 0);
  const highTotal = computeGoalieTotalAdj(weak, { ...weak });
  assert.ok(highTotal > 0);
  const extreme = computeGoalieTotalAdj(
    { savePct: 0.850, confirmed: true }, { savePct: 0.850, confirmed: true });
  assert.strictEqual(extreme, TOTAL_ADJ_CAP);
  assert.strictEqual(computeGoalieTotalAdj(null, null), 0);
});

test('pickPresumedStarter: most GP wins, composite score breaks ties', () => {
  const starter = pickPresumedStarter([
    { name: 'Backup', gp: 20, score: 90 },
    { name: 'Starter', gp: 55, score: 70 },
  ]);
  assert.strictEqual(starter.name, 'Starter');
  assert.strictEqual(starter.confirmed, false, 'rankings-derived starters are presumed');

  const tied = pickPresumedStarter([
    { name: 'A', gp: 40, score: 60 },
    { name: 'B', gp: 40, score: 80 },
  ]);
  assert.strictEqual(tied.name, 'B');
  assert.strictEqual(pickPresumedStarter([]), null);
});

test('extractGoalieFromProbables parses MLB-probables-like shape defensively', () => {
  const goalie = extractGoalieFromProbables([{
    athlete: { displayName: 'Test Goalie', id: '12345' },
    statistics: [
      { name: 'savePct', value: 0.918, displayValue: '.918' },
      { name: 'goalsAgainstAverage', value: 2.31, displayValue: '2.31' },
    ],
  }]);
  assert.strictEqual(goalie.name, 'Test Goalie');
  assert.strictEqual(goalie.savePct, 0.918);
  assert.strictEqual(goalie.gaa, 2.31);
  assert.strictEqual(goalie.confirmed, true);
});

test('extractGoalieFromProbables tolerates missing/odd shapes', () => {
  assert.strictEqual(extractGoalieFromProbables(null), null);
  assert.strictEqual(extractGoalieFromProbables([]), null);
  assert.strictEqual(extractGoalieFromProbables([{ statistics: [] }]), null, 'no athlete name → null');
  // Alternate stat key naming still lands
  const alt = extractGoalieFromProbables([{
    athlete: { fullName: 'Alt Shape' },
    stats: [{ abbreviation: 'SV%', value: 0.905 }],
  }]);
  assert.strictEqual(alt.name, 'Alt Shape');
  assert.strictEqual(alt.savePct, 0.905);
});

test('end-to-end synthetic matchup: adj lands in a bettable, sane band', () => {
  // Hellebuyck-tier confirmed starter vs a presumed mid backup
  const home = { name: 'Star', savePct: 0.922, confirmed: true };
  const away = { name: 'Presumed Backup', savePct: 0.893, confirmed: false };
  const adj = computeGoalieAdj(home, away);
  // home dev: 28.5×0.022 ≈ 0.627; away dev: 28.5×(-0.007)×0.7 ≈ -0.14 → ≈ 0.767 → cap 0.75
  assert.ok(adj > 0.5 && adj <= MARGIN_ADJ_CAP, `got ${adj}`);
  // At the config-seeded 0.5 scale in game-model this contributes ≤ 0.375
  // goals to the margin — meaningful but conservative vs NHL HA (~0.2-0.3 goals).
  assert.ok(adj * 0.5 <= 0.38);
});
