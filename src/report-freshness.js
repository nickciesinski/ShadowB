'use strict';
// =============================================================
// src/report-freshness.js
//
// Is the weekly scoreboard silent because everything is fine, because a job is
// deliberately paused, or because it is broken? Today nothing answers that.
//
// WHY THIS EXISTS. On 2026-09-20 the Sunday roadmap run opened the repo at
// 16:04 UTC and found no clean-era report for that day, against a 12:30 UTC
// cron that had committed on time every Sunday since 2026-08-09. It looked
// broken. It was not: the run landed at 16:37 UTC, 4h07m after its cron, and
// the only way to know that in advance was to hand-check the commit times of
// every prior report and discover that GitHub's scheduled queue had already
// delivered them anywhere from 0h38m to 4h24m late. A naive "is the file
// there?" check run at 16:04 would have cried wolf.
//
// The week before, the opposite: `threshold-reviews/` had been empty since
// 2026-08-02 and the run had to read the workflow YAML to establish that the
// silence was deliberate (scheduled runs pass --dry-run and skip the commit),
// not a failing job.
//
// Both directions are the same defect. The 41-day Supabase outage went
// unnoticed because a silent failure printed success; src/staleness.js made
// that decision a pure function so a test could prove the tripwire fires.
// This is that lesson applied one layer up, to the reporting layer itself --
// the layer we would use to notice anything else going wrong.
//
// This module performs NO I/O and has NO side effects. It never looks at a
// file mtime: a fresh `git clone` rewrites every mtime to checkout time, so
// mtime says when you cloned, not when the report was produced. The date in
// the filename is the only honest source, and the caller does that parsing.
// =============================================================

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

// Statuses. `failing` = something is broken. `needsReview` = nothing is
// broken, but a decision is overdue. They are deliberately NOT merged: an
// alert that fires for both stops being read for either.
const OK = 'OK';                     // current artifact present
const LATE = 'LATE';                 // due, not here yet, still inside the grace window
const MISSING = 'MISSING';           // due, not here, grace window closed  -> failing
const PAUSED = 'PAUSED';             // silent on purpose, with a stated reason
const PAUSED_STALE = 'PAUSED_STALE'; // paused so long the pause itself needs a look
const CONFIG_ERROR = 'CONFIG_ERROR'; // the manifest can't be trusted -> failing

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function toIsoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The most recent scheduled instant at or before `nowMs` matching a UTC
 * day-of-week and time. Returns null if none in the last 14 days (impossible
 * for a weekly cadence, but a malformed dow shouldn't loop forever).
 */
function mostRecentDue(nowMs, dow, hour, minute) {
  const now = new Date(nowMs);
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0
  ));
  for (let i = 0; i < 15; i++) {
    if (d.getUTCDay() === dow && d.getTime() <= nowMs) return d.getTime();
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return null;
}

/**
 * Evaluate one artifact.
 *
 * @param {Object} artifact  manifest entry (see config/report-freshness.json)
 * @param {string[]} dates   ISO dates (YYYY-MM-DD) parsed from that directory's
 *                           filenames by the caller. Order irrelevant.
 * @param {number} nowMs
 */
function evaluateArtifact(artifact, dates, nowMs) {
  const id = (artifact && artifact.id) || '(unnamed)';
  const base = { id: id, latest: null, dueDate: null, hoursLate: null };

  if (!artifact || typeof artifact.id !== 'string' || !artifact.id) {
    return Object.assign({}, base, { status: CONFIG_ERROR, detail: 'manifest entry has no id' });
  }

  // --- deliberate silence -------------------------------------------------
  // A pause is allowed, but it must say why and since when. An unexplained
  // `paused: true` is how a genuinely dead job hides forever, so it is a
  // config error rather than a pass.
  if (artifact.paused === true) {
    const reason = typeof artifact.paused_reason === 'string' ? artifact.paused_reason.trim() : '';
    if (!reason) {
      return Object.assign({}, base, { status: CONFIG_ERROR, detail: 'paused without a paused_reason' });
    }
    if (!isIsoDate(artifact.paused_on)) {
      return Object.assign({}, base, { status: CONFIG_ERROR, detail: 'paused without a valid paused_on date' });
    }
    const pausedDays = (nowMs - Date.parse(artifact.paused_on + 'T00:00:00Z')) / MS_PER_DAY;
    const reviewAfter = Number(artifact.review_after_days);
    if (Number.isFinite(reviewAfter) && pausedDays > reviewAfter) {
      return Object.assign({}, base, {
        status: PAUSED_STALE,
        pausedDays: Math.floor(pausedDays),
        detail: 'paused ' + Math.floor(pausedDays) + 'd (review after ' + reviewAfter + 'd): ' + reason
      });
    }
    return Object.assign({}, base, {
      status: PAUSED,
      pausedDays: Math.floor(pausedDays),
      detail: reason
    });
  }

  // --- live artifact ------------------------------------------------------
  const list = Array.isArray(dates) ? dates : [];
  const bad = list.filter(function (d) { return !isIsoDate(d); });
  if (bad.length) {
    // Loud, not skipped. A date we can't parse is a date we can't reason
    // about, and quietly dropping it is how a report looks present and isn't.
    return Object.assign({}, base, {
      status: CONFIG_ERROR,
      detail: 'unparseable date(s): ' + bad.slice(0, 3).join(', ')
    });
  }

  const dow = Number(artifact.dow);
  const hour = Number(artifact.due_utc_hour);
  const minute = Number(artifact.due_utc_minute);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6
      || !Number.isInteger(hour) || hour < 0 || hour > 23
      || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return Object.assign({}, base, { status: CONFIG_ERROR, detail: 'invalid dow / due_utc_hour / due_utc_minute' });
  }

  const graceHours = Number(artifact.grace_hours);
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    return Object.assign({}, base, { status: CONFIG_ERROR, detail: 'invalid grace_hours' });
  }

  const dueMs = mostRecentDue(nowMs, dow, hour, minute);
  if (dueMs === null) {
    return Object.assign({}, base, { status: CONFIG_ERROR, detail: 'no scheduled instant in the last 14 days' });
  }
  const dueDate = toIsoDate(dueMs);
  const latest = list.length ? list.slice().sort().pop() : null;
  const hoursLate = (nowMs - dueMs) / MS_PER_HOUR;

  if (latest !== null && latest >= dueDate) {
    return Object.assign({}, base, { status: OK, latest: latest, dueDate: dueDate, hoursLate: null });
  }

  // Due and not here. Inside the grace window this is the scheduler being
  // slow, which is normal and must not page anyone.
  const status = hoursLate <= graceHours ? LATE : MISSING;
  return Object.assign({}, base, {
    status: status,
    latest: latest,
    dueDate: dueDate,
    hoursLate: Math.round(hoursLate * 100) / 100,
    detail: latest === null
      ? 'no dated file has ever landed; ' + hoursLate.toFixed(1) + 'h past the ' + dueDate + ' slot (grace ' + graceHours + 'h)'
      : 'newest is ' + latest + '; ' + hoursLate.toFixed(1) + 'h past the ' + dueDate + ' slot (grace ' + graceHours + 'h)'
  });
}

/**
 * Evaluate the whole manifest.
 *
 * @param {Object} opts
 * @param {Array}  opts.artifacts  manifest entries
 * @param {Object} opts.present    { [id]: ISO date strings }
 * @param {number} [opts.nowMs]
 * @returns {{results:Array, failing:Array, needsReview:Array, ok:boolean}}
 *          `ok` is false only when something is BROKEN (MISSING / CONFIG_ERROR).
 *          A stale pause lands in `needsReview` and leaves `ok` true -- it is a
 *          decision that is overdue, not an outage, and conflating the two is
 *          how a weekly alert becomes background noise.
 */
function evaluateReportFreshness(opts) {
  const o = opts || {};
  const present = o.present || {};
  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const list = Array.isArray(o.artifacts) ? o.artifacts : [];
  const results = list.map(function (a) { return evaluateArtifact(a, present[a && a.id], nowMs); });
  const failing = results.filter(function (r) { return r.status === MISSING || r.status === CONFIG_ERROR; });
  const needsReview = results.filter(function (r) { return r.status === PAUSED_STALE; });
  return { results: results, failing: failing, needsReview: needsReview, ok: failing.length === 0 };
}

module.exports = {
  evaluateReportFreshness: evaluateReportFreshness,
  evaluateArtifact: evaluateArtifact,
  mostRecentDue: mostRecentDue,
  STATUS: { OK: OK, LATE: LATE, MISSING: MISSING, PAUSED: PAUSED, PAUSED_STALE: PAUSED_STALE, CONFIG_ERROR: CONFIG_ERROR }
};
