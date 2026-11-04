'use strict';
// 2026-11-03 — weekly injury tuner: the maths and the promotion gate.
const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/injury-tuning');

test('spread target: result vs the closing line, from the home side', () => {
  // Home -5 at close, home wins by 9 → beat the close by 4.
  const r = t.gameRow('NBA', { game_date: '2026-11-01', home_team: 'H', away_team: 'A', pick: 'H', close_line: '-5', home_score: 109, away_score: 100 }, { injury_gap_diff_v0: 0.2 });
  assert.strictEqual(r.y, 4);
  // Same game, we picked the away side at +5.
  const r2 = t.gameRow('NBA', { game_date: '2026-11-01', home_team: 'H', away_team: 'A', pick: 'A', close_line: '5', home_score: 109, away_score: 100 }, {});
  assert.strictEqual(r2.y, 4);
  assert.strictEqual(r2.x.v0, 0);
});

test('moneyline target (NHL): win minus closing probability', () => {
  const r = t.gameRow('NHL', { home_team: 'H', away_team: 'A', pick: 'A', close_novig_prob: '0.4', home_score: 3, away_score: 2 }, {});
  assert.ok(Math.abs(r.y - 0.4) < 1e-9); // home won, home close prob 0.6
});

// Synthetic season: residual = 6 points per unit of gap (+ noise) for v1 only.
function season(days, slope = 6, today = '2026-12-31') {
  const rows = []; let seed = 1;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
  for (let d = days; d >= 0; d--) {
    const dt = new Date(`${today}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - d);
    for (let g = 0; g < 4; g++) {
      const x = rnd();
      rows.push({ date: dt.toISOString().slice(0, 10), y: slope * x + rnd() * 2, x: { v0: rnd(), v1: x, v2: x * 0.5 + rnd() * 0.3 } });
    }
  }
  return rows;
}

test('finds the formula that explains results and qualifies it', () => {
  const w = t.evaluateWeek(season(90), '2026-12-31');
  assert.strictEqual(w.variant, 'v1');
  assert.strictEqual(w.verdict, 'qualify');
  assert.ok(Math.abs(w.fullFit.b - 6) < 1);
});

test('pure noise does not qualify; thin data changes nothing', () => {
  assert.notStrictEqual(t.evaluateWeek(season(90, 0), '2026-12-31').verdict, 'qualify');
  assert.strictEqual(t.evaluateWeek(season(5), '2026-12-31').verdict, 'insufficient');
});

test('promotes after 3 qualifying weeks, demotes on a bad week', () => {
  const q = { verdict: 'qualify', variant: 'v1', holdout: { lift: 0.1, n: 40 } };
  let s = undefined, ev;
  for (let i = 0; i < 2; i++) ({ state: s, event: ev } = t.transition(s, q, 0.8, `2026-12-0${i + 1}`));
  assert.strictEqual(s.status, 'QUARANTINED'); assert.strictEqual(s.streak, 2); assert.strictEqual(s.weight, 0);
  ({ state: s, event: ev } = t.transition(s, q, 0.8, '2026-12-08'));
  assert.strictEqual(ev, 'promoted'); assert.strictEqual(s.weight, 0.8); assert.strictEqual(s.variant, 'v1');
  ({ state: s, event: ev } = t.transition(s, { ...q, verdict: 'degrade' }, 0.8, '2026-12-15'));
  assert.strictEqual(ev, 'demoted'); assert.strictEqual(s.weight, 0); assert.strictEqual(s.status, 'QUARANTINED');
});

test('a miss resets the streak; an insufficient week does not', () => {
  const q = { verdict: 'qualify', variant: 'v0', holdout: { lift: 0.1, n: 40 } };
  let { state: s } = t.transition(undefined, q, 1, 'a');
  ({ state: s } = t.transition(s, { ...q, verdict: 'insufficient' }, 1, 'b'));
  assert.strictEqual(s.streak, 1);
  ({ state: s } = t.transition(s, { ...q, verdict: 'miss' }, 1, 'c'));
  assert.strictEqual(s.streak, 0);
});

test('slope converts to a model weight on the model\'s own scale', () => {
  // NBA: 6 pts per unit / (8 × 0.3) = 2.5
  assert.strictEqual(t.slopeToWeight('NBA', 6, 0.3), 2.5);
  // NHL: 0.17 win prob per unit at 0.17 prob/goal = 1 goal / (1 × 0.3)
  assert.ok(Math.abs(t.slopeToWeight('NHL', 0.17, 0.3, 0.17) - 3.333) < 1e-3);
  assert.strictEqual(t.slopeToWeight('NBA', 100, 0.3), 5); // clamped
});
