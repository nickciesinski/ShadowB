#!/usr/bin/env node
'use strict';
// =============================================================
// scripts/report-freshness-check.js
//
// Answers, once a week and out loud: is every committed report artifact
// current, deliberately paused, merely queued, or actually broken?
//
// All the judgement lives in the pure src/report-freshness.js. This file is
// only the I/O boundary: read the manifest, list each directory, hand the
// DATES IN THE FILENAMES (never mtimes -- a fresh clone rewrites those) to the
// decision function, print, and set an exit code.
//
// Exit codes are split on purpose:
//   0  everything current, late-but-queued, or paused with a reason
//   1  something is BROKEN (MISSING / CONFIG_ERROR)
// A pause held past its review window prints a REVIEW banner and still exits
// 0. It is an overdue decision, not an outage, and an alarm that fires for
// both stops being read for either.
//
// Report-only. Reads nothing but the repo's own committed files; touches no
// pick, stake, price or grade path; needs no secrets, so it runs anywhere.
// =============================================================

const fs = require('fs');
const path = require('path');
const { evaluateReportFreshness, STATUS } = require('../src/report-freshness');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config', 'report-freshness.json');
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

// Files a report directory carries that are not reports.
const NOT_A_REPORT = new Set(['README.md', '.gitkeep']);

function datesIn(dir) {
  const abs = path.join(ROOT, dir);
  // A missing directory is zero reports, not a crash. A paused artifact whose
  // workflow has never been merged (novig-fill-reports today) is the normal
  // case, and throwing here would take the whole check down with it.
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => !NOT_A_REPORT.has(f) && !f.startsWith('.'))
    .map((f) => {
      const m = DATE_PREFIX.exec(f);
      // Undated filenames are skipped rather than passed through as garbage --
      // a report dir may legitimately hold e.g. a sweep sub-directory. Dates
      // that LOOK like dates and aren't are passed through, so the pure
      // function can fail loud on them.
      return m ? m[1] : null;
    })
    .filter((d) => d !== null);
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const nowArg = (argv.find((a) => a.startsWith('--now=')) || '').slice('--now='.length);
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (Number.isNaN(nowMs)) {
    console.error('--now must be an ISO timestamp');
    process.exit(2);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    console.error('Could not read ' + CONFIG + ': ' + err.message);
    process.exit(2);
  }

  const artifacts = cfg.artifacts || [];
  const present = {};
  for (const a of artifacts) {
    if (a && a.id) present[a.id] = datesIn(a.dir || a.id);
  }

  const out = evaluateReportFreshness({ artifacts, present, nowMs });

  if (asJson) {
    console.log(JSON.stringify({ checkedAt: new Date(nowMs).toISOString(), ...out }, null, 2));
  } else {
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    console.log('Report freshness — checked ' + new Date(nowMs).toISOString());
    console.log('');
    for (const r of out.results) {
      const a = byId.get(r.id) || {};
      const mark = r.status === STATUS.OK ? 'OK   '
        : r.status === STATUS.LATE ? 'LATE '
          : r.status === STATUS.PAUSED ? 'PAUSE'
            : r.status === STATUS.PAUSED_STALE ? 'REVIEW'
              : 'FAIL ';
      console.log(mark + '  ' + r.id.padEnd(22) + '  ' + (a.label || ''));
      if (r.status === STATUS.OK) {
        console.log('       newest ' + r.latest + ' (due ' + r.dueDate + ')');
      } else if (r.detail) {
        console.log('       ' + r.detail);
      }
    }
    console.log('');
    if (out.needsReview.length) {
      console.log('REVIEW — these are paused on purpose, but the pause is older than its');
      console.log('review window. Nothing is broken; a decision is overdue.');
      for (const r of out.needsReview) console.log('  · ' + r.id + ': ' + r.detail);
      console.log('');
    }
    if (out.failing.length) {
      console.log('BROKEN — ' + out.failing.length + ' artifact(s) are past their grace window or misconfigured:');
      for (const r of out.failing) console.log('  · ' + r.id + ' [' + r.status + '] ' + (r.detail || ''));
      console.log('');
      console.log('Check the workflow run for each before assuming the data is bad.');
    } else {
      console.log('No broken artifacts.');
    }
  }

  process.exit(out.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { datesIn };
