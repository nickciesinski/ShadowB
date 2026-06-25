'use strict';
// =============================================================
// scripts/sheets-exit-healthcheck.js
//
// Watches the Google-Sheets-exit migration. For every data entity flipped off
// 'sheet' (mode 'dual'/'supabase'), it compares the Sheet against Supabase and
// flags problems: Supabase unreachable, snapshot STALE (a dual-write that was
// working and stopped), or row-count divergence. If anything looks wrong it
// emails Nick so he can return to the Cowork thread. Healthy => no email.
//
// "No snapshot yet" is a NOTICE (logged, not emailed): it's expected right
// after flipping an entity, until the first refresh trigger dual-writes.
//
// Run: node scripts/sheets-exit-healthcheck.js   (scheduled daily + dispatch)
// Exits 1 when problems are found (so the workflow also goes red).
// =============================================================
require('dotenv').config();
const nodemailer = require('nodemailer');
const { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENTS, DATA_SOURCE_MODES, dataModeFor } = require('../src/config');
const db = require('../src/db');
const { REGISTRY } = require('../src/data-store');

const STALE_HOURS = 36;          // snapshot older than this => dual-write likely stopped
const SNAPSHOT_ENTITIES = new Set(['gameOdds', 'scheduleContext', 'injuries', 'yesterdayResults', 'playerTiers']);

const rowCount = (v) => (Array.isArray(v) ? Math.max(0, v.length - 1) : 0);
// Pure alert-vs-noise logic lives in healthcheck-lib.js (offline-tested).
const { isTransientError, withRetry, diverges } = require('./healthcheck-lib');

async function checkEntity(entity) {
  const mode = dataModeFor(entity);
  if (mode === 'sheet') return null;                 // not migrated yet — skip
  const ent = REGISTRY[entity];
  if (!ent || !ent.supa) return null;                // no Supabase side — skip

  const problems = [], notices = [];
  let sheetN = null, supaN = null;

  try { sheetN = rowCount(await withRetry(() => ent.sheet())); }
  catch (e) {
    // Failing to read the AUTHORITATIVE Sheet says nothing about whether the
    // Supabase shadow diverged, so it is NOT a migration problem and must not page.
    // Log as a notice; the snapshot-staleness + Supabase reads below still catch
    // real dual-write failures. Count comparison is simply skipped this run.
    const kind = isTransientError(e) ? 'transient' : 'persistent';
    notices.push(`Sheet read failed (${kind}, count comparison skipped this run): ${e.message}`);
  }

  if (SNAPSHOT_ENTITIES.has(entity)) {
    let info = null;
    try { info = await db.getSnapshotInfo(entity); }
    catch (e) { problems.push(`Snapshot metadata check failed: ${e.message}`); }

    if (!info) {
      notices.push('No Supabase snapshot yet (expected until the first dual-write)');
    } else {
      const ageH = (Date.now() - new Date(info.capturedAt).getTime()) / 3.6e6;
      if (ageH > STALE_HOURS) problems.push(`Snapshot is stale (${ageH.toFixed(0)}h old) — dual-write may have stopped`);
      try {
        supaN = rowCount(await withRetry(() => ent.supa()));
        if (sheetN != null && diverges(sheetN, supaN)) problems.push(`Row-count divergence: Sheet=${sheetN}, Supabase=${supaN}`);
      } catch (e) { problems.push(`Supabase read failed: ${e.message}`); }
    }
  } else {
    // typed-table entity (e.g. modifierRows): Supabase should return data
    try {
      supaN = rowCount(await withRetry(() => ent.supa()));
      if (sheetN != null && sheetN > 0 && supaN === 0) problems.push(`Supabase returned 0 rows but Sheet has ${sheetN}`);
      else if (sheetN != null && diverges(sheetN, supaN)) problems.push(`Row-count divergence: Sheet=${sheetN}, Supabase=${supaN}`);
    } catch (e) { problems.push(`Supabase read failed: ${e.message}`); }
  }

  return { entity, mode, sheetN, supaN, problems, notices };
}

async function main() {
  const results = [];
  const globalProblems = [];
  if (!db.isEnabled()) globalProblems.push('Supabase is not configured (SUPABASE_URL / SERVICE_ROLE_KEY missing)');

  for (const entity of Object.keys(DATA_SOURCE_MODES)) {
    const r = await checkEntity(entity).catch((e) => ({ entity, mode: dataModeFor(entity), problems: [`checker error: ${e.message}`], notices: [] }));
    if (r) results.push(r);
  }

  const failing = results.filter((r) => r.problems.length > 0);
  console.log(`[healthcheck] entities off-sheet: ${results.length}; failing: ${failing.length}; global issues: ${globalProblems.length}`);
  for (const r of results) {
    const tag = r.problems.length ? 'PROBLEM' : (r.notices.length ? 'notice' : 'ok');
    const detail = [...r.problems, ...(r.notices || [])].join('; ');
    console.log(`  [${tag}] ${r.entity} (${r.mode}) sheet=${r.sheetN} supa=${r.supaN}${detail ? ' :: ' + detail : ''}`);
  }

  if (globalProblems.length === 0 && failing.length === 0) {
    console.log('[healthcheck] all migrated entities healthy — no email sent.');
    return;
  }
  await sendAlert(globalProblems, failing, results.length);
  process.exitCode = 1;
}

async function sendAlert(globalProblems, failing, active) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !EMAIL_RECIPIENTS.length) {
    console.warn('[healthcheck] problems found but email not configured — skipping email.');
    return;
  }
  const rows = failing.map((r) =>
    `<tr><td style="padding:4px 10px;border:1px solid #ddd">${r.entity}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd">${r.mode}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd">sheet=${r.sheetN}, supa=${r.supaN}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd;color:#b00">${r.problems.join('<br>')}</td></tr>`).join('');
  const globalHtml = globalProblems.length ? `<p style="color:#b00"><b>System:</b> ${globalProblems.join('; ')}</p>` : '';
  const html = `
    <h2>⚠️ Shadow Bets — Sheets-exit health check found problems</h2>
    <p>${failing.length} migrated entit${failing.length === 1 ? 'y' : 'ies'} of ${active} look wrong. The Sheet is still authoritative, so your picks are unaffected — but the Supabase shadow needs attention before that entity can be cut over.</p>
    ${globalHtml}
    ${rows ? `<table style="border-collapse:collapse;font-family:monospace;font-size:13px"><tr><th style="padding:4px 10px;border:1px solid #ddd">entity</th><th style="padding:4px 10px;border:1px solid #ddd">mode</th><th style="padding:4px 10px;border:1px solid #ddd">counts</th><th style="padding:4px 10px;border:1px solid #ddd">problem</th></tr>${rows}</table>` : ''}
    <p><b>To fix:</b> reopen your Cowork thread about the Google Sheets migration and paste what this email says — Claude has the full context to diagnose and patch it.</p>
    <p style="color:#888;font-size:11px">Automated by scripts/sheets-exit-healthcheck.js · scheduled daily</p>`;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: `⚠️ Shadow Bets Sheets-exit: ${failing.length || globalProblems.length} issue(s) need attention`,
    html,
  });
  console.log(`[healthcheck] alert email sent to ${EMAIL_RECIPIENTS.length} recipient(s).`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[healthcheck] FATAL:', e.message); process.exitCode = 1; });
}

module.exports = { checkEntity };
