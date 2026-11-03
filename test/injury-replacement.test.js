'use strict';
// 2026-11-03 — an absence is worth the gap between the player and his
// replacement, not the player's rating alone.
const test = require('node:test');
const assert = require('node:assert');
const { computeReplacementImpact } = require('../src/injury-replacement');

const qb = (name, score, status = '') => ({ name, team: 'BUF', pos: 'QB', score, status });

test('a star with a bad backup is a big swing', () => {
  const { players, teams } = computeReplacementImpact('NFL', [qb('Star', 98, 'out'), qb('Backup', 40)]);
  const star = players.find(p => p.name === 'Star');
  assert.strictEqual(star.replacement, 'Backup');
  assert.ok(Math.abs(star.impact - 0.58) < 1e-9);
  assert.ok(Math.abs(teams.BUF - 0.58) < 1e-9);
});

test('a role-player starter with a decent backup barely matters', () => {
  const { teams } = computeReplacementImpact('NFL', [qb('Starter', 60, 'out'), qb('Backup', 56)]);
  assert.ok(teams.BUF < 0.05);
});

test('a bench player out matters not at all', () => {
  const { teams } = computeReplacementImpact('NFL', [qb('Starter', 90), qb('Backup', 50, 'out')]);
  assert.ok(!teams.BUF);
});

test('questionable counts partially; long-term absences are off the depth chart', () => {
  const q = computeReplacementImpact('NFL', [qb('Star', 90, 'questionable'), qb('Backup', 40)]);
  assert.ok(Math.abs(q.teams.BUF - 0.5 * 0.4) < 1e-9);
  // Star on IR: the backup is now the starter, and nothing is charged.
  const ir = computeReplacementImpact('NFL', [qb('Star', 90, 'injured reserve'), qb('Backup', 40)]);
  assert.ok(!ir.teams.BUF);
  assert.strictEqual(ir.players.find(p => p.name === 'Backup').starter, true);
});

test('two starters out at the same spot need two different replacements', () => {
  const g = (name, score, status = '') => ({ name, team: 'LAL', pos: 'G', score, status });
  const { players } = computeReplacementImpact('NBA', [g('A', 95, 'out'), g('B', 80, 'out'), g('C', 60), g('D', 45)]);
  assert.strictEqual(players.find(p => p.name === 'A').replacement, 'C');
  assert.strictEqual(players.find(p => p.name === 'B').replacement, 'D');
});

test('NBA: with no backup at the position, the best healthy bench player fills in', () => {
  const { players } = computeReplacementImpact('NBA', [
    { name: 'Big', team: 'TOR', pos: 'C', score: 70, status: 'out' },
    { name: 'Wing', team: 'TOR', pos: 'F', score: 80 }, { name: 'Wing2', team: 'TOR', pos: 'F', score: 75 },
    { name: 'Sixth', team: 'TOR', pos: 'F', score: 62 },
  ]);
  const big = players.find(p => p.name === 'Big');
  assert.strictEqual(big.replacement, 'Sixth');
  assert.ok(Math.abs(big.impact - 0.08) < 1e-9);
});
