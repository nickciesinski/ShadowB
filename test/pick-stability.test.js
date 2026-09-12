'use strict';
// 2026-09-11 — a published pick must never change sides.
//
// Nick bets by hand in a ~30 minute window (9-9:30 PM PT or 5:30-6 AM PT). The
// final-card job deliberately re-runs odds and predictions before the morning
// email, so the same game is processed more than once. If a re-run could
// rewrite a side, he could wake up to the opposite bet from the one he placed
// the night before — or, worse, place both. He has been explicit that one
// stable pick beats a sharper pick that flips.
//
// The guarantee is in the DB, not in convention: performance_log is upserted
// with onConflict 'pick_id' and ignoreDuplicates TRUE, which PostgREST sends as
// ON CONFLICT DO NOTHING. Flipping that to DO UPDATE (ignoreDuplicates false)
// would silently let the last run of the night win.
//
// This test exists because that is a one-word change in a file nobody re-reads,
// and nothing else in the suite would notice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');

test('performance_log upsert is DO NOTHING, never DO UPDATE', () => {
  const m = dbSrc.match(/\.upsert\(\s*withId\s*,\s*\{([^}]*)\}/);
  assert.ok(m, 'could not find the performance_log upsert — did it move?');
  const opts = m[1];
  assert.match(opts, /onConflict:\s*['"]pick_id['"]/,
    'the exactly-once key must be pick_id');
  assert.match(opts, /ignoreDuplicates:\s*true/,
    'ignoreDuplicates:true = DO NOTHING. false would let a later run overwrite a '
    + 'side Nick may already have bet.');
});

test('no DO-UPDATE upsert has crept into the performance_log path', () => {
  // A second upsert onto performance_log with different options would reopen
  // the hole from the other side.
  const perfUpserts = dbSrc.match(/from\('performance_log'\)\s*\n?\s*\.upsert\([^)]*\)/g) || [];
  for (const u of perfUpserts) {
    assert.ok(!/ignoreDuplicates:\s*false/.test(u),
      `a performance_log upsert allows overwrite: ${u}`);
  }
});

test('the ledger is the arbiter, so re-running a slate cannot rewrite a side', () => {
  // Documents the intended shape rather than re-testing the DB: the DB write is
  // NOT gated on the sheet dedupe, because gating it meant a re-run whose picks
  // were already in the sheet wrote nothing to the DB at all.
  assert.match(dbSrc, /Exactly-once locking is enforced by the DB/,
    'the rationale comment is load-bearing for anyone editing this');
});
