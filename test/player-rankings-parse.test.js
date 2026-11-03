'use strict';
// 2026-11-03 — rankings read "1,793" passing yards as 1, "23:28" ice time as
// 23, and let a QB's 2021 kicking line and his defensive (0) interceptions
// overwrite this season's passing stats.
const test = require('node:test');
const assert = require('node:assert');
const { parseStatValue, flattenAthleteStats, computeCompositeScores } = require('../src/player-rankings');

test('numbers with commas, clock times and leading dots parse correctly', () => {
  assert.strictEqual(parseStatValue('1,793'), 1793);
  assert.ok(Math.abs(parseStatValue('23:28') - 23.4667) < 1e-3);
  assert.strictEqual(parseStatValue('.927'), 0.927);
  assert.strictEqual(parseStatValue('8.5-18.0'), null);
});

test('only current-season categories count, and the first category wins', () => {
  const cat = (name, year, names, stats) => ({ name, names, statistics: [{ season: { year }, stats }] });
  const s = flattenAthleteStats({ categories: [
    cat('passing', 2026, ['passingYards', 'interceptions'], ['1,793', '5']),
    cat('defensive', 2026, ['interceptions'], ['0']),
    cat('kicking', 2021, ['fieldGoalPct'], ['0.0']),
  ] });
  assert.strictEqual(s.passingYards, 1793);
  assert.strictEqual(s.interceptions, 5);
  assert.ok(!('fieldGoalPct' in s));
});

test('a one-catch receiver does not outrank a starter on yards per touch', () => {
  const mk = (name, yds, td, touches) => ({ name, stats: { scrimmageYards: yds, scrimmageTouchdowns: td, touches, yardsPerTouch: yds / touches } });
  const ps = [mk('one catch', 27, 0, 1), mk('starter', 900, 6, 60)];
  for (let i = 0; i < 20; i++) ps.push(mk(`depth ${i}`, 100 + i * 10, i % 3, 15 + i));
  computeCompositeScores(ps, 'NFL_SKILL');
  const by = Object.fromEntries(ps.map(p => [p.name, p.compositeScore]));
  assert.ok(by.starter > by['one catch'] + 20, JSON.stringify(by));
});
