'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildTriggerRow, writeTriggerLog } = require('../src/trigger-log');

const silentLog = { warn() {}, log() {} };
const base = { name: 'trigger4', status: 'SUCCESS', startMs: 1000, endMs: 6000, records: '12' };

test('buildTriggerRow yields the 10-column layout in order', () => {
  const r = buildTriggerRow({ ...base, memMb: 80 });
  assert.strictEqual(r.length, 10);
  assert.strictEqual(r[1], 'trigger4');   // B function
  assert.strictEqual(r[2], 'SUCCESS');    // C status
  assert.strictEqual(r[5], '5.00');       // F duration (6000-1000)/1000
  assert.strictEqual(r[6], '12');         // G records
  assert.strictEqual(r[9], 80);           // J memory
});

test('PRIMARY: a full/throwing sheet does NOT block the Supabase write', async () => {
  let logged = null;
  const db = { isEnabled: () => true, logTrigger: async (p) => { logged = p; } };
  const appendRows = async () => { throw new Error('exceeds 10000000 cell limit'); };
  const res = await writeTriggerLog(base, { db, appendRows, spreadsheetId: 'X', sheet: 'Trigger_Monitor', log: silentLog });
  assert.strictEqual(res.supabaseOk, true);
  assert.strictEqual(res.sheetOk, false);
  assert.ok(logged && logged.trigger_name === 'trigger4');
  assert.strictEqual(logged.duration_sec, 5);
});

test('a throwing Supabase write does NOT block the sheet mirror', async () => {
  let appended = null;
  const db = { isEnabled: () => true, logTrigger: async () => { throw new Error('supabase 503'); } };
  const appendRows = async (sid, sheet, rows) => { appended = { sid, sheet, rows }; };
  const res = await writeTriggerLog(base, { db, appendRows, spreadsheetId: 'X', sheet: 'Trigger_Monitor', log: silentLog });
  assert.strictEqual(res.supabaseOk, false);
  assert.strictEqual(res.sheetOk, true);
  assert.strictEqual(appended.rows[0][1], 'trigger4');
});

test('db disabled: skips Supabase, still writes the sheet', async () => {
  let appended = false;
  const db = { isEnabled: () => false, logTrigger: async () => { throw new Error('should not be called'); } };
  const appendRows = async () => { appended = true; };
  const res = await writeTriggerLog(base, { db, appendRows, spreadsheetId: 'X', sheet: 'Trigger_Monitor', log: silentLog });
  assert.strictEqual(res.supabaseOk, false);
  assert.strictEqual(res.sheetOk, true);
  assert.ok(appended);
});

test('both writes succeed in the happy path', async () => {
  const db = { isEnabled: () => true, logTrigger: async () => {} };
  const appendRows = async () => {};
  const res = await writeTriggerLog(base, { db, appendRows, spreadsheetId: 'X', sheet: 'Trigger_Monitor', log: silentLog });
  assert.deepStrictEqual(res, { supabaseOk: true, sheetOk: true });
});
