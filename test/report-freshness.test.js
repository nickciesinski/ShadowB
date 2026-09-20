'use strict';
// Tests for src/report-freshness.js -- the "late vs paused vs broken" tripwire.
//
// The refusals below are the point of the module. Each one is a mistake a
// naive freshness check makes, and each cost a real Sunday run time:
//   * crying MISSING at a report that is merely queued (2026-09-20, 4h07m late)
//   * reading a deliberate pause as an outage (threshold-reviews since 08-02)
//   * reading an outage as a deliberate pause (the 41-day Supabase silence)
//   * trusting file mtime in a fresh clone (mtime = when you cloned)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  evaluateReportFreshness,
  evaluateArtifact,
  mostRecentDue,
  STATUS,
} = require('../src/report-freshness');

const SUN_1230 = { id: 'x', dow: 0, due_utc_hour: 12, due_utc_minute: 30, grace_hours: 8, paused: false };
const at = (iso) => Date.parse(iso);

// --- the scheduler is slow; that is not an outage -------------------------

test('a report that has not landed yet, inside the grace window, is LATE not MISSING', () => {
  // The real 2026-09-20 situation: cron 12:30 UTC, checked at 16:04, newest
  // file still 09-13. The report actually landed at 16:37. A check that says
  // MISSING here is the one that teaches everyone to ignore it.
  const r = evaluateArtifact(SUN_1230, ['2026-09-06', '2026-09-13'], at('2026-09-20T16:04:00Z'));
  assert.strictEqual(r.status, STATUS.LATE);
  assert.strictEqual(r.dueDate, '2026-09-20');
  assert.strictEqual(r.latest, '2026-09-13');
  assert.ok(r.hoursLate > 3.5 && r.hoursLate < 3.7, 'reports how late it is: ' + r.hoursLate);
});

test('the same artifact flips to OK once the report lands', () => {
  const r = evaluateArtifact(SUN_1230, ['2026-09-13', '2026-09-20'], at('2026-09-20T16:40:00Z'));
  assert.strictEqual(r.status, STATUS.OK);
  assert.strictEqual(r.latest, '2026-09-20');
  assert.strictEqual(r.hoursLate, null);
});

test('grace is a boundary, not a vibe: at exactly grace_hours it is still LATE', () => {
  const r = evaluateArtifact(SUN_1230, ['2026-09-13'], at('2026-09-20T20:30:00Z')); // +8h00m
  assert.strictEqual(r.status, STATUS.LATE);
});

test('one minute past grace it is MISSING', () => {
  const r = evaluateArtifact(SUN_1230, ['2026-09-13'], at('2026-09-20T20:31:00Z'));
  assert.strictEqual(r.status, STATUS.MISSING);
  assert.match(r.detail, /newest is 2026-09-13/);
});

test('a whole week with no report is MISSING, and stays MISSING', () => {
  const r = evaluateArtifact(SUN_1230, ['2026-09-06'], at('2026-09-20T23:00:00Z'));
  assert.strictEqual(r.status, STATUS.MISSING);
});

test('a directory that has never produced anything is MISSING, not silently OK', () => {
  const r = evaluateArtifact(SUN_1230, [], at('2026-09-20T23:00:00Z'));
  assert.strictEqual(r.status, STATUS.MISSING);
  assert.strictEqual(r.latest, null);
  assert.match(r.detail, /has ever landed/);
});

test('a report from the future does not make a later due slot look satisfied', () => {
  // Midweek check: last due slot was Sunday 09-20 and 09-20 is present -> OK.
  const r = evaluateArtifact(SUN_1230, ['2026-09-20'], at('2026-09-23T09:00:00Z'));
  assert.strictEqual(r.status, STATUS.OK);
  assert.strictEqual(r.dueDate, '2026-09-20');
});

test('before the first due slot of the week, last week\'s report still counts as OK', () => {
  // Saturday. The most recent Sunday slot is 09-13, which we have.
  const r = evaluateArtifact(SUN_1230, ['2026-09-13'], at('2026-09-19T09:00:00Z'));
  assert.strictEqual(r.status, STATUS.OK);
  assert.strictEqual(r.dueDate, '2026-09-13');
});

test('Sunday morning BEFORE the cron fires does not demand today\'s report', () => {
  // 08:00 UTC, cron is 12:30. Due slot is still last Sunday.
  const r = evaluateArtifact(SUN_1230, ['2026-09-13'], at('2026-09-20T08:00:00Z'));
  assert.strictEqual(r.status, STATUS.OK);
  assert.strictEqual(r.dueDate, '2026-09-13');
});

// --- deliberate silence ---------------------------------------------------

test('a paused artifact is PAUSED, never MISSING, however long the directory has been quiet', () => {
  const a = {
    id: 'threshold-reviews', dow: 0, due_utc_hour: 13, due_utc_minute: 0, grace_hours: 8,
    paused: true, paused_on: '2026-08-02',
    paused_reason: 'scheduled runs are --dry-run; a threshold move would be fitted to noise',
    review_after_days: 120,
  };
  const r = evaluateArtifact(a, ['2026-08-02'], at('2026-09-20T23:00:00Z'));
  assert.strictEqual(r.status, STATUS.PAUSED);
  assert.strictEqual(r.pausedDays, 49);
  assert.match(r.detail, /dry-run/);
});

test('a pause with no stated reason is a CONFIG_ERROR -- silence must be justified', () => {
  // Without this, `paused: true` becomes the universal way to mute a job that
  // is actually dead. That is precisely how the 41-day outage survived.
  const r = evaluateArtifact(
    { id: 'x', paused: true, paused_on: '2026-08-02', review_after_days: 120 },
    [], at('2026-09-20T23:00:00Z'),
  );
  assert.strictEqual(r.status, STATUS.CONFIG_ERROR);
  assert.match(r.detail, /paused_reason/);
});

test('a pause with a blank reason is also a CONFIG_ERROR', () => {
  const r = evaluateArtifact(
    { id: 'x', paused: true, paused_on: '2026-08-02', paused_reason: '   ' },
    [], at('2026-09-20T23:00:00Z'),
  );
  assert.strictEqual(r.status, STATUS.CONFIG_ERROR);
});

test('a pause with no paused_on is a CONFIG_ERROR -- an undated pause can never go stale', () => {
  const r = evaluateArtifact(
    { id: 'x', paused: true, paused_reason: 'because' },
    [], at('2026-09-20T23:00:00Z'),
  );
  assert.strictEqual(r.status, STATUS.CONFIG_ERROR);
  assert.match(r.detail, /paused_on/);
});

test('a pause held past its review window becomes PAUSED_STALE', () => {
  const a = {
    id: 'novig-fill-reports', paused: true, paused_on: '2026-09-13',
    paused_reason: 'venue test paused, 4 fills of 40', review_after_days: 90,
  };
  const fresh = evaluateArtifact(a, [], at('2026-11-01T00:00:00Z'));
  assert.strictEqual(fresh.status, STATUS.PAUSED);
  const stale = evaluateArtifact(a, [], at('2026-12-20T00:00:00Z'));
  assert.strictEqual(stale.status, STATUS.PAUSED_STALE);
  assert.match(stale.detail, /review after 90d/);
});

test('a pause with no review_after_days never goes stale (opt-in, not assumed)', () => {
  const a = { id: 'x', paused: true, paused_on: '2020-01-01', paused_reason: 'retired on purpose' };
  const r = evaluateArtifact(a, [], at('2026-09-20T00:00:00Z'));
  assert.strictEqual(r.status, STATUS.PAUSED);
});

// --- refusing to guess ----------------------------------------------------

test('an unparseable date fails loud rather than being skipped', () => {
  const r = evaluateArtifact(SUN_1230, ['2026-09-13', 'README', '2026-13-45'], at('2026-09-20T23:00:00Z'));
  assert.strictEqual(r.status, STATUS.CONFIG_ERROR);
  assert.match(r.detail, /unparseable/);
});

test('a malformed schedule is a CONFIG_ERROR, not a default that silently passes', () => {
  for (const bad of [
    { id: 'x', dow: 9, due_utc_hour: 12, due_utc_minute: 30, grace_hours: 8 },
    { id: 'x', dow: 0, due_utc_hour: 25, due_utc_minute: 30, grace_hours: 8 },
    { id: 'x', dow: 0, due_utc_hour: 12, due_utc_minute: 61, grace_hours: 8 },
    { id: 'x', dow: 0, due_utc_hour: 12, due_utc_minute: 30, grace_hours: -1 },
    { id: 'x', dow: 0, due_utc_hour: 12, due_utc_minute: 30 },
  ]) {
    assert.strictEqual(
      evaluateArtifact(bad, [], at('2026-09-20T23:00:00Z')).status,
      STATUS.CONFIG_ERROR,
      JSON.stringify(bad),
    );
  }
});

test('an entry with no id is a CONFIG_ERROR', () => {
  assert.strictEqual(evaluateArtifact({}, [], Date.now()).status, STATUS.CONFIG_ERROR);
  assert.strictEqual(evaluateArtifact(null, [], Date.now()).status, STATUS.CONFIG_ERROR);
});

// --- broken vs overdue-decision are different alarms ----------------------

test('ok is false only when something is BROKEN; a stale pause does not fail the job', () => {
  const artifacts = [
    { id: 'live', dow: 0, due_utc_hour: 12, due_utc_minute: 30, grace_hours: 8, paused: false },
    { id: 'old', paused: true, paused_on: '2026-01-01', paused_reason: 'r', review_after_days: 30 },
  ];
  const out = evaluateReportFreshness({
    artifacts,
    present: { live: ['2026-09-20'], old: [] },
    nowMs: at('2026-09-20T16:40:00Z'),
  });
  assert.strictEqual(out.ok, true, 'a stale pause is an overdue decision, not an outage');
  assert.strictEqual(out.failing.length, 0);
  assert.strictEqual(out.needsReview.length, 1);
  assert.strictEqual(out.needsReview[0].id, 'old');
});

test('a genuinely missing report fails the job', () => {
  const out = evaluateReportFreshness({
    artifacts: [{ id: 'live', dow: 0, due_utc_hour: 12, due_utc_minute: 30, grace_hours: 8, paused: false }],
    present: { live: ['2026-09-06'] },
    nowMs: at('2026-09-20T23:00:00Z'),
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.failing.length, 1);
  assert.strictEqual(out.failing[0].status, STATUS.MISSING);
});

test('a LATE report does NOT fail the job', () => {
  const out = evaluateReportFreshness({
    artifacts: [{ id: 'live', dow: 0, due_utc_hour: 12, due_utc_minute: 30, grace_hours: 8, paused: false }],
    present: { live: ['2026-09-13'] },
    nowMs: at('2026-09-20T16:04:00Z'),
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.results[0].status, STATUS.LATE);
});

test('an id with no entry in `present` is treated as an empty directory, not skipped', () => {
  const out = evaluateReportFreshness({
    artifacts: [{ id: 'live', dow: 0, due_utc_hour: 12, due_utc_minute: 30, grace_hours: 8, paused: false }],
    present: {},
    nowMs: at('2026-09-20T23:00:00Z'),
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.results[0].status, STATUS.MISSING);
});

test('an empty manifest is ok=true and says nothing -- it does not invent a pass', () => {
  const out = evaluateReportFreshness({ artifacts: [], present: {}, nowMs: Date.now() });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.results.length, 0);
});

// --- mostRecentDue --------------------------------------------------------

test('mostRecentDue walks back to the correct Sunday slot', () => {
  assert.strictEqual(new Date(mostRecentDue(at('2026-09-20T16:04:00Z'), 0, 12, 30)).toISOString(),
    '2026-09-20T12:30:00.000Z');
  assert.strictEqual(new Date(mostRecentDue(at('2026-09-20T08:00:00Z'), 0, 12, 30)).toISOString(),
    '2026-09-13T12:30:00.000Z');
  assert.strictEqual(new Date(mostRecentDue(at('2026-09-24T00:00:00Z'), 0, 12, 30)).toISOString(),
    '2026-09-20T12:30:00.000Z');
});

test('mostRecentDue handles a slot exactly at now', () => {
  assert.strictEqual(mostRecentDue(at('2026-09-20T12:30:00Z'), 0, 12, 30), at('2026-09-20T12:30:00Z'));
});

// --- the module must stay pure -------------------------------------------

test('report-freshness.js performs no I/O -- mtime is not a freshness signal', () => {
  // A fresh `git clone` rewrites every file mtime to checkout time. A checker
  // that reads mtime reports "everything is fresh" on every clone, which is
  // exactly backwards. Pin that the decision module cannot reach the disk.
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'report-freshness.js'), 'utf8');
  assert.ok(!/require\(['"]fs['"]\)/.test(text), 'must not require fs');
  assert.ok(!/require\(['"]path['"]\)/.test(text), 'must not require path');
  assert.ok(!/mtime/i.test(text.replace(/\/\/.*$/gm, '')), 'must not consult mtime outside comments');
});

test('the shipped config/report-freshness.json parses and every entry is well-formed', () => {
  const cfg = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'report-freshness.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.artifacts) && cfg.artifacts.length > 0);
  // Evaluate the real manifest against empty directories. Nothing may come
  // back CONFIG_ERROR -- that would mean the shipped file is itself malformed.
  const out = evaluateReportFreshness({
    artifacts: cfg.artifacts,
    present: {},
    nowMs: at('2026-09-20T23:00:00Z'),
  });
  const cfgErrors = out.results.filter((r) => r.status === STATUS.CONFIG_ERROR);
  assert.deepStrictEqual(cfgErrors, [], 'shipped manifest must be well-formed');
  for (const a of cfg.artifacts) {
    assert.ok(a.dir && typeof a.dir === 'string', a.id + ' needs a dir');
    assert.ok(a.label && typeof a.label === 'string', a.id + ' needs a label');
  }
});

test('every live (unpaused) artifact in the shipped manifest names a workflow that exists', () => {
  // A live entry whose workflow was deleted would sit at MISSING forever and
  // train the reader to ignore the report.
  const cfg = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'report-freshness.json'), 'utf8'));
  const root = path.join(__dirname, '..');
  for (const a of cfg.artifacts) {
    if (a.paused === true) continue;
    assert.ok(fs.existsSync(path.join(root, a.workflow)),
      a.id + ' names a workflow that does not exist: ' + a.workflow);
    assert.ok(fs.existsSync(path.join(root, a.dir)),
      a.id + ' names a directory that does not exist: ' + a.dir);
  }
});

// --- module seams ---------------------------------------------------------
//
// These two assertions belong in test/module-contracts.test.js by subject.
// They live here instead, deliberately: three other roadmap patches are
// queued and unapplied, two of them already append to module-contracts, and
// a fourth patch touching the same file would force Nick to resolve a
// conflict by hand for no benefit. Kept self-contained, this patch modifies
// no existing file and applies in any order. Fold them into module-contracts
// once the queue is drained.

test('src/report-freshness.js exports what the checker destructures', () => {
  const mod = require('../src/report-freshness');
  for (const name of ['evaluateReportFreshness', 'evaluateArtifact', 'mostRecentDue']) {
    assert.strictEqual(typeof mod[name], 'function',
      'src/report-freshness.js must export ' + name + ' — scripts/report-freshness-check.js imports it');
  }
});

test('report-freshness is a monitor and no live path may import it', () => {
  // The calibration.js lesson applied to a checker: a module that only WATCHES
  // the pipeline must never become something the pipeline depends on. If a
  // pick, stake or grade path ever required this, a malformed manifest could
  // stop pick generation — the monitor would become the outage.
  const root = path.join(__dirname, '..');
  const allowed = new Set(['report-freshness-check.js', 'report-freshness.js']);
  const offenders = [];
  for (const dir of [path.join(root, 'src'), path.join(root, 'scripts')]) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || allowed.has(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/require\(['"][^'"]*report-freshness['"]\)/.test(text)) {
        offenders.push(path.basename(dir) + '/' + f);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'report-freshness is report-only; these import it: ' + offenders.join(', '));
});
