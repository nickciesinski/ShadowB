'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { persistGameOdds } = require('../src/odds-sink');

const rows = [
  ['ts','sport','home','away','commence','market','outcome','price','point','book'],
  ['t','MLB','A','B','c','h2h','A','-110','','dk'],
  ['t','MLB','A','B','c','h2h','B','+100','','fd'],
];
const silent = { warn() {}, log() {} };
const baseDeps = () => ({
  mode: 'dual',
  spreadsheetId: 'SID', gameOddsSheet: 'Game_Odds', historicalSheet: 'Historical_Odds',
  log: silent,
});

test('REGRESSION: snapshot is written even when the Sheet write throws (the 53h-stale cause)', async () => {
  let snapshotRows = null;
  const deps = {
    ...baseDeps(),
    insertSnapshot: async (entity, r) => { snapshotRows = { entity, n: r.length }; },
    clearSheet: async () => {},
    setValues: async () => { throw new Error('Invalid response body ... oauth2/v4/token: Premature close'); },
    appendRows: async () => {},
  };
  // Sheet write still fails loudly (alerts), but only AFTER the snapshot is safe.
  await assert.rejects(() => persistGameOdds(rows, deps), /Premature close/);
  assert.ok(snapshotRows, 'snapshot must have been written before the sheet failure');
  assert.strictEqual(snapshotRows.entity, 'gameOdds');
  assert.strictEqual(snapshotRows.n, 3);
});

test('happy path: snapshot + sheet + historical all run, snapshotOk true', async () => {
  const calls = [];
  const deps = {
    ...baseDeps(),
    insertSnapshot: async () => { calls.push('snap'); },
    clearSheet: async () => { calls.push('clear'); },
    setValues: async () => { calls.push('set'); },
    appendRows: async () => { calls.push('hist'); },
  };
  const res = await persistGameOdds(rows, deps);
  assert.deepStrictEqual(res, { snapshotOk: true });
  // snapshot must come before the sheet write
  assert.ok(calls.indexOf('snap') < calls.indexOf('set'));
  assert.deepStrictEqual(calls, ['snap','clear','set','hist']);
});

test('mode=sheet skips the snapshot but still writes the sheet', async () => {
  let snapCalled = false, setCalled = false;
  const deps = {
    ...baseDeps(), mode: 'sheet',
    insertSnapshot: async () => { snapCalled = true; },
    clearSheet: async () => {},
    setValues: async () => { setCalled = true; },
    appendRows: async () => {},
  };
  const res = await persistGameOdds(rows, deps);
  assert.strictEqual(snapCalled, false);
  assert.strictEqual(setCalled, true);
  assert.strictEqual(res.snapshotOk, false);
});

test('a failing snapshot is swallowed (best-effort) and does NOT block the sheet write', async () => {
  let setCalled = false;
  const deps = {
    ...baseDeps(),
    insertSnapshot: async () => { throw new Error('supabase 503'); },
    clearSheet: async () => {},
    setValues: async () => { setCalled = true; },
    appendRows: async () => {},
  };
  const res = await persistGameOdds(rows, deps);
  assert.strictEqual(res.snapshotOk, false);
  assert.strictEqual(setCalled, true);
});
