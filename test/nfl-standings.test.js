'use strict';
// 2026-09-25 — ESPN's NFL /teams list has no record and /teams/{abbr}/statistics
// has no points allowed, so every NFL team was .500 with no defense stat. The
// standings endpoint (nested conference → division children) has both.
const test = require('node:test');
const assert = require('node:assert');
const { fetchNflStandings } = require('../src/data-collection');

const entry = (abbr, w, l, t, pf, pa) => ({ team: { abbreviation: abbr }, stats: [
  { name: 'wins', value: w }, { name: 'losses', value: l }, { name: 'ties', value: t },
  { name: 'pointsFor', value: pf }, { name: 'pointsAgainst', value: pa }] });

test('reads records and points from nested standings', async () => {
  const body = { children: [
    { standings: { entries: [entry('BUF', 2, 0, 0, 77, 62)] } },
    { children: [{ standings: { entries: [entry('CLE', 0, 2, 0, 30, 51)] } }] },
  ] };
  const s = await fetchNflStandings(async () => ({ ok: true, json: async () => body }));
  assert.deepStrictEqual(s.BUF, { wins: 2, losses: 0, ties: 0, pointsFor: 77, pointsAgainst: 62 });
  assert.strictEqual(s.CLE.pointsAgainst, 51, 'nested division children are walked');
});

test('a failed fetch returns empty, never throws', async () => {
  assert.deepStrictEqual(await fetchNflStandings(async () => ({ ok: false })), {});
  assert.deepStrictEqual(await fetchNflStandings(async () => { throw new Error('down'); }), {});
});
