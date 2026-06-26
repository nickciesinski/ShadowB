'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { persistSnapshotFirst } = require('../src/snapshot-sink');

const rows = [['h1','h2'], ['a','b']];
const silent = { warn() {}, log() {} };

test('REGRESSION: snapshot is written before a throwing sheet write (any entity)', async () => {
  for (const entity of ['scheduleContext', 'injuries', 'yesterdayResults', 'playerTiers']) {
    let snapped = null;
    await assert.rejects(() => persistSnapshotFirst({
      entity, rows, mode: 'dual',
      insertSnapshot: async (e, r) => { snapped = { e, n: r.length }; },
      writeSheet: async () => { throw new Error('oauth2/v4/token: Premature close'); },
      log: silent,
    }), /Premature close/);
    assert.ok(snapped, `${entity}: snapshot must be written before the sheet failure`);
    assert.strictEqual(snapped.e, entity);
    assert.strictEqual(snapped.n, 2);
  }
});

test('happy path: snapshot before sheet, snapshotOk true', async () => {
  const order = [];
  const res = await persistSnapshotFirst({
    entity: 'injuries', rows, mode: 'dual',
    insertSnapshot: async () => { order.push('snap'); },
    writeSheet: async () => { order.push('sheet'); },
    log: silent,
  });
  assert.deepStrictEqual(res, { snapshotOk: true });
  assert.deepStrictEqual(order, ['snap', 'sheet']);
});

test('mode=sheet skips snapshot, still writes sheet', async () => {
  let snap = false, sheet = false;
  const res = await persistSnapshotFirst({
    entity: 'injuries', rows, mode: 'sheet',
    insertSnapshot: async () => { snap = true; },
    writeSheet: async () => { sheet = true; },
    log: silent,
  });
  assert.strictEqual(snap, false);
  assert.strictEqual(sheet, true);
  assert.strictEqual(res.snapshotOk, false);
});

test('snapshot failure is best-effort and does not block the sheet write', async () => {
  let sheet = false;
  const res = await persistSnapshotFirst({
    entity: 'injuries', rows, mode: 'dual',
    insertSnapshot: async () => { throw new Error('supabase 503'); },
    writeSheet: async () => { sheet = true; },
    log: silent,
  });
  assert.strictEqual(res.snapshotOk, false);
  assert.strictEqual(sheet, true);
});
