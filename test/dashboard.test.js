'use strict';
// Offline tests for src/dashboard.js (R0.3 Dashboard rebuild).
const test = require('node:test');
const assert = require('node:assert');
const { buildDashboard, summarize, marketOf } = require('../src/dashboard');

const NOW = new Date('2026-10-27T04:00:00Z'); // Mon 10/26 9:00 PM PT
const row = (o) => ({ approval_status: 'approved', pick_regime: 'v2_clv', league: 'NBA', market: 'total', final_units: 1, ...o });
const find = (out, label) => out.find(r => r[0] === label);

test('summarize: record, win%, units and ROI over staked graded rows', () => {
  const s = summarize([
    row({ result: 'W', unit_return: 0.9 }),
    row({ result: 'L', unit_return: -1 }),
    row({ result: 'P', unit_return: 0 }),
    row({ result: null, unit_return: null }), // ungraded: ignored
  ]);
  assert.strictEqual(s.record, '1-1-1');
  assert.strictEqual(s.winPct, '50.0%');
  assert.strictEqual(s.units, '-0.10');
  assert.strictEqual(s.roi, '-3.3%');
});

test('marketOf normalises over/under and h2h', () => {
  assert.strictEqual(marketOf({ market: 'over' }), 'total');
  assert.strictEqual(marketOf({ market: 'h2h' }), 'moneyline');
  assert.strictEqual(marketOf({ market: 'Spread' }), 'spread');
});

test('upcoming lists only approved, ungraded picks from today (PT) on', () => {
  const out = buildDashboard({ now: NOW, perfRows: [
    row({ date: '2026-10-26', game_date: '2026-10-27', game: 'A @ B', pick: 'Over 230' }),
    row({ date: '2026-10-26', game_date: '2026-10-26', game: 'C @ D', pick: 'Under 220' }),
    row({ date: '2026-10-25', game_date: '2026-10-25', game: 'E @ F', pick: 'Over 1' }),  // past
    row({ date: '2026-10-26', game_date: '2026-10-27', game: 'G @ H', result: 'W' }),     // graded
    row({ date: '2026-10-26', game_date: '2026-10-27', game: 'I @ J', approval_status: 'tracking' }),
    row({ date: '2026-10-26', game_date: '2026-10-27', game: 'K @ L', pick_regime: 'v1_daily' }),
  ] });
  const games = out.filter(r => r[0] && /^2026-/.test(r[0])).map(r => r[2]);
  assert.deepStrictEqual(games, ['C @ D', 'A @ B']);
});

test('windows count by Pacific date and skip pre-clean-era rows', () => {
  const out = buildDashboard({ now: NOW, perfRows: [
    row({ date: '2026-10-25', result: 'W', unit_return: 1 }),
    row({ date: '2026-10-01', result: 'L', unit_return: -1 }),
    row({ date: '2026-05-01', result: 'W', unit_return: 5 }), // before clean era
  ] });
  assert.strictEqual(find(out, 'Last 7 days')[1], '1-0');
  assert.strictEqual(find(out, 'Last 30 days')[1], '1-1');
  assert.strictEqual(find(out, 'Since 2026-06-03 (clean era)')[1], '1-1');
});

test('system health shows the latest run of each job', () => {
  const out = buildDashboard({ now: NOW, triggerRuns: [
    { trigger_name: 'trigger3', status: 'error', start_time: '2026-10-26T10:00:00Z', error_message: 'boom' },
    { trigger_name: 'trigger3', status: 'success', start_time: '2026-10-26T20:00:00Z' },
    { trigger_name: 'trigger14', status: 'success', start_time: '2026-10-26T09:00:00Z' },
  ] });
  const t3 = find(out, 'trigger3');
  assert.strictEqual(t3[2], 'success');
  assert.strictEqual(out.filter(r => r[0] === 'trigger3').length, 1);
  assert.ok(find(out, 'trigger14'));
});

test('empty inputs render a readable page, not a crash', () => {
  const out = buildDashboard({ now: NOW });
  assert.ok(find(out, 'No approved picks waiting right now'));
  assert.ok(out.some(r => /No job runs logged/.test(r[0] || '')));
  assert.match(out[0][0], /^SHADOW BETS DASHBOARD — /);
});
