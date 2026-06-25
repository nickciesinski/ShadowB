'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { expectedTriggersFor, mergeTriggerRuns, categorize } = require('../src/trigger-health');

test('expected list is 12 daily triggers, +trigger13 on Monday only', () => {
  assert.strictEqual(expectedTriggersFor(0).length, 12); // Sun
  assert.strictEqual(expectedTriggersFor(2).length, 12); // Tue
  const mon = expectedTriggersFor(1);
  assert.strictEqual(mon.length, 13);
  assert.ok(mon.includes('trigger13'));
});

test('mergeTriggerRuns backfills Supabase rows the Sheet missed (Sheets wins ties)', () => {
  const sheetMap = {
    trigger9:  { status: 'SUCCESS', duration: '5.38' },
    trigger12: { status: 'SUCCESS', duration: '19.74' },
    trigger14: { status: 'SUCCESS', duration: '78.81' },
  };
  const dbRuns = [
    { trigger_name: 'trigger1', status: 'SUCCESS', duration_sec: 4 },
    { trigger_name: 'trigger4', status: 'SUCCESS', duration_sec: 9 },
    { trigger_name: 'trigger9', status: 'FAILED', duration_sec: 1 }, // must NOT override Sheets
  ];
  const merged = mergeTriggerRuns(sheetMap, dbRuns);
  assert.strictEqual(merged.trigger1.status, 'SUCCESS');
  assert.strictEqual(merged.trigger4.duration, '9');
  assert.strictEqual(merged.trigger9.status, 'SUCCESS'); // Sheets precedence preserved
  // input not mutated
  assert.strictEqual(Object.keys(sheetMap).length, 3);
});

test('REGRESSION: at exactly 3 Sheet rows, Supabase backfill still prevents false "missing"', () => {
  // Reproduces the reported alert: Sheet captured only trigger9/12/14; the other
  // 9 actually ran and are in Supabase. With unconditional merge, nothing is missing.
  const expected = expectedTriggersFor(0);
  const sheetMap = {
    trigger9:  { status: 'SUCCESS', duration: '5.38' },
    trigger12: { status: 'SUCCESS', duration: '19.74' },
    trigger14: { status: 'SUCCESS', duration: '78.81' },
  };
  const dbRuns = ['trigger1','trigger2','trigger3','trigger4','trigger6','trigger7','trigger8','trigger10','trigger11']
    .map((n) => ({ trigger_name: n, status: 'SUCCESS', duration_sec: 5 }));
  const merged = mergeTriggerRuns(sheetMap, dbRuns);
  const { passed, failed, missing } = categorize(expected, merged);
  assert.strictEqual(missing.length, 0);
  assert.strictEqual(failed.length, 0);
  assert.strictEqual(passed.length, 12);
});

test('categorize still reports genuinely absent triggers as missing', () => {
  const expected = expectedTriggersFor(0);
  const runMap = { trigger1: { status: 'SUCCESS', duration: '5' } };
  const { passed, missing } = categorize(expected, runMap);
  assert.strictEqual(passed.length, 1);
  assert.strictEqual(missing.length, 11);
  assert.ok(missing.includes('trigger4'));
});

test('categorize flags FAILED status as failed, not passed', () => {
  const { failed, passed } = categorize(['trigger4'], { trigger4: { status: 'FAILED', error: 'boom', duration: '2' } });
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].error, 'boom');
  assert.strictEqual(passed.length, 0);
});

test('mergeTriggerRuns tolerates null/empty dbRuns', () => {
  const m = mergeTriggerRuns({ trigger9: { status: 'SUCCESS' } }, null);
  assert.strictEqual(Object.keys(m).length, 1);
});
