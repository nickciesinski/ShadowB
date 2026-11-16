'use strict';
// Weekly bias-drift report: pure lean math + verdict bands.
const test = require('node:test');
const assert = require('node:assert');
const d = require('../scripts/bias-drift-report');

const g = 'Away Team @ Home Team';
const row = (o) => ({ league: 'NBA', market: 'spread', game: g, approval_status: 'approved', ...o });

test('verdict bands: OK / WATCH within 3 pts / DRIFT outside', () => {
  assert.strictEqual(d.verdict(50, [38, 62]), 'OK');
  assert.strictEqual(d.verdict(60, [38, 62]), 'WATCH');
  assert.strictEqual(d.verdict(40, [38, 62]), 'WATCH');
  assert.strictEqual(d.verdict(63, [38, 62]), 'DRIFT');
  assert.strictEqual(d.verdict(22, [38, 62]), 'DRIFT');
  assert.strictEqual(d.verdict(null, [38, 62]), '—');
});

test('spread: 9/9 favorites -> DRIFT on Fav%', () => {
  const rows = Array.from({ length: 9 }, (_, i) => row({ pick: i < 3 ? 'Home Team' : 'Away Team', line: -4.5 }));
  const c = d.cellStats(rows, 'spread');
  assert.strictEqual(c.favPct, 100);
  assert.strictEqual(c.homePct, 33.3);
  assert.strictEqual(c.verdict, 'DRIFT');
});

test('moneyline: 100% favorites is note-only (Home% drives verdict)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ market: 'moneyline', pick: i < 5 ? 'Home Team' : 'Away Team', odds: -150 }));
  const c = d.cellStats(rows, 'moneyline');
  assert.strictEqual(c.favPct, 100);
  assert.strictEqual(c.verdict, 'OK');
});

test('totals: Over% from pick text', () => {
  const rows = [row({ market: 'total', pick: 'Over 220.5' }), row({ market: 'total', pick: 'Under 219' }),
    row({ market: 'total', pick: 'Under 230' }), row({ market: 'total', pick: 'Under 210' })];
  const c = d.cellStats(rows, 'total');
  assert.strictEqual(c.overPct, 25);
  assert.strictEqual(c.verdict, 'DRIFT');
});

test('analyze splits all vs staked and by league x market', () => {
  const rows = [row({ pick: 'Home Team', line: -3 }), row({ pick: 'Away Team', line: 3, approval_status: 'tracking_only' }),
    row({ league: 'NFL', market: 'total', pick: 'Over 44' })];
  const cells = d.analyze(rows);
  const nba = cells.find(c => c.league === 'NBA' && c.market === 'spread');
  assert.strictEqual(nba.all.n, 2);
  assert.strictEqual(nba.staked.n, 1);
  assert.ok(cells.find(c => c.league === 'NFL' && c.market === 'total'));
});

test('weightsCheck flags a regressed anchor or sp_prob, passes the fixed values', () => {
  const ok = { params: { param_auto_total_market_anchor: 0.95 }, moneyline: { sp_prob_home: 0.1, sp_prob_away: 0.1 } };
  const bad = { params: { param_auto_total_market_anchor: 0.8 }, moneyline: { sp_prob_home: 2.1, sp_prob_away: 2.1 } };
  assert.strictEqual(d.weightsCheck({ NBA: ok }).drift, false);
  const w = d.weightsCheck({ NBA: bad });
  assert.strictEqual(w.drift, true);
  assert.match(w.lines.find(l => l.league === 'NBA').note, /anchor 0.8.*sp_prob 2.1/);
});

test('shipped model-params pass the weights check (fixes intact)', () => {
  const fs = require('fs'), path = require('path');
  const p = {};
  for (const lg of ['NFL', 'NBA', 'NHL', 'MLB']) p[lg] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', `model-params.${lg}.json`), 'utf8'));
  assert.strictEqual(d.weightsCheck(p).drift, false);
});

test('favCoverRate counts graded favorites only', () => {
  const r = d.favCoverRate([row({ line: -5, result: 'W' }), row({ line: -5, result: 'L' }), row({ line: -5, result: 'W' }),
    row({ line: 5, result: 'W' }), row({ line: -2, result: '' })]);
  assert.deepStrictEqual(r, { w: 2, l: 1, pct: 66.7 });
});

test('empty window -> report says pipeline may be down', () => {
  const md = d.buildMarkdown({ dateStr: '2026-11-22', from: '2026-11-15', to: '2026-11-21', latestPickDate: '2026-11-10',
    rows: [], cells: [], weights: { lines: [], drift: false }, cover: null });
  assert.match(md, /NO PICKS IN WINDOW/);
});
