#!/usr/bin/env node
'use strict';
/**
 * scripts/admin-reset.js
 *
 * One-shot post-bug-fix data hygiene:
 *   1. Verify Supabase performance_log dual-write is alive (max date within 2d)
 *   2. Reset performance_modifiers to 1.0 across all rows
 *   3. Reset Calibration_Data sheet multipliers to 1.0 across all buckets
 *
 * Rationale: the spread sign error + total Over bias (fixed 2026-05-31) corrupted
 * every downstream learning system. Modifiers and calibration buckets were
 * trained against biased outcomes. Reset to neutral and let them relearn from
 * clean data over the next 14-30 days.
 *
 * Usage:
 *   node scripts/admin-reset.js                     # do it all
 *   node scripts/admin-reset.js --verify-only       # check Supabase recency only
 *   node scripts/admin-reset.js --skip-modifiers
 *   node scripts/admin-reset.js --skip-calibration
 *   node scripts/admin-reset.js --dry-run           # report only, no writes
 */

const db = require('../src/db');
const { getValues, setValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const { evaluateRecency, STALE_MAX_AGE_DAYS } = require('../src/staleness');

const args = process.argv.slice(2);
const VERIFY_ONLY = args.includes('--verify-only');
const SKIP_MODIFIERS = args.includes('--skip-modifiers');
const SKIP_CALIBRATION = args.includes('--skip-calibration');
const DRY_RUN = args.includes('--dry-run');

async function verifySupabaseRecency() {
  console.log('\n[1/3] Verifying Supabase performance_log dual-write recency...');
  if (!db.isEnabled()) {
    console.log('  Supabase not configured — skipping verify');
    return { ok: false, reason: 'not_configured' };
  }
  const sb = db.getClient();
  const { data, error } = await sb
    .from('performance_log')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);
  if (error) {
    console.error('  ERROR querying performance_log:', error.message);
    return { ok: false, reason: error.message };
  }
  // Recency decision extracted to pure src/staleness.js (offline-testable; Autopilot #4)
  const result = evaluateRecency({ rows: data, maxAgeDays: STALE_MAX_AGE_DAYS });
  if (result.reason === 'empty_table') {
    console.warn('  WARNING: performance_log is empty');
    return result;
  }
  console.log(`  Latest date in Supabase performance_log: ${result.latest} (${result.ageDays.toFixed(1)} days old)`);
  if (result.reason === 'stale') {
    console.error(`  STALE: dual-write may have stopped. Check trigger12/trigger4 logs.`);
    return result;
  }
  console.log('  OK — dual-write is current');
  return result;
}

async function resetModifiers() {
  console.log('\n[2/3] Resetting performance_modifiers to 1.0...');
  if (!db.isEnabled()) {
    console.log('  Supabase not configured — skipping reset');
    return;
  }
  const sb = db.getClient();
  const { data: existing, error: readErr } = await sb
    .from('performance_modifiers')
    .select('league, market, modifier, sample_size, updated_at');
  if (readErr) {
    console.error('  ERROR reading modifiers:', readErr.message);
    return;
  }
  console.log(`  Current rows: ${existing.length}`);
  for (const row of existing) {
    console.log(`    ${row.league}|${row.market}: mod=${row.modifier}, samples=${row.sample_size}, updated=${row.updated_at}`);
  }
  if (DRY_RUN) {
    console.log('  [DRY RUN] Would reset all modifiers to 1.0');
    return;
  }
  for (const row of existing) {
    await db.upsertModifier({
      league: row.league,
      market: row.market,
      modifier: 1.0,
      sample_size: 0,        // wipe the sample so next nightly run starts fresh
      win_rate: null,
      roi: null,
    });
  }
  console.log(`  Reset ${existing.length} modifier rows to 1.0`);
}

async function resetCalibration() {
  console.log('\n[3/3] Resetting Calibration_Data sheet to 1.0 multipliers...');
  const sheetName = SHEETS.CALIBRATION || 'Calibration_Data';
  let rows;
  try {
    rows = await getValues(SPREADSHEET_ID, sheetName);
  } catch (e) {
    console.warn(`  Could not read ${sheetName}:`, e.message);
    return;
  }
  if (!rows || rows.length < 2) {
    console.log('  Calibration_Data empty or missing — nothing to reset');
    return;
  }
  const headers = rows[0];
  const multIdx = headers.findIndex(h =>
    /multiplier|sizing|adjust/i.test(String(h))
  );
  if (multIdx < 0) {
    console.warn(`  Could not find multiplier column in headers: ${JSON.stringify(headers)}`);
    return;
  }
  console.log(`  Found ${rows.length - 1} calibration rows, multiplier column index ${multIdx}`);
  const updated = rows.map((r, i) => {
    if (i === 0) return r;
    const copy = [...r];
    copy[multIdx] = 1.0;
    return copy;
  });
  if (DRY_RUN) {
    console.log('  [DRY RUN] Would set all multipliers to 1.0');
    return;
  }
  await setValues(SPREADSHEET_ID, `${sheetName}!A1`, updated);
  console.log(`  Reset ${rows.length - 1} calibration multipliers to 1.0`);
}

(async () => {
  console.log('=== admin-reset starting ===');
  console.log(`DRY_RUN=${DRY_RUN} VERIFY_ONLY=${VERIFY_ONLY} SKIP_MODIFIERS=${SKIP_MODIFIERS} SKIP_CALIBRATION=${SKIP_CALIBRATION}`);
  const verify = await verifySupabaseRecency();
  if (VERIFY_ONLY) {
    console.log('\nverify-only flag set — exiting');
    process.exit(verify.ok ? 0 : 1);
  }
  if (!verify.ok) {
    console.warn('\n[warn] Supabase verify did not pass — proceeding with resets anyway.');
    console.warn('[warn] The resets are still safe (they don\'t touch performance_log).');
    console.warn('[warn] But once dual-write is restored, you may want to re-run this.');
  }
  if (!SKIP_MODIFIERS) await resetModifiers();
  if (!SKIP_CALIBRATION) await resetCalibration();
  console.log('\n=== admin-reset complete ===');
  // Exit 0 on successful resets even if verify failed (verify is informational)
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
