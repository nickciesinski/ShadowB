#!/usr/bin/env node
'use strict';
/**
 * scripts/backfill-stake-zero.js
 *
 * Cleans up historical Performance Log rows where Units == 0 but unit_return
 * was written as -1.00. That was the fallout of an old `parseFloat(row[10]) || 1`
 * fallback in gradePerformanceLog() — zero-stake bets were graded as 1-unit
 * losses, polluting ROI math.
 *
 * What this script does:
 *   - Reads the full Performance Log
 *   - For each row where Units (col 10) parses to 0 AND unit_return (col 17)
 *     is non-zero, zeroes out unit_return. Result (col 16) stays as-is so
 *     win% metrics are preserved.
 *   - Optionally (--regrade) also clears result + unit_return so the nightly
 *     trigger12 can regrade them at the new (tiny) stake. Default is off.
 *
 * Usage:
 *   node scripts/backfill-stake-zero.js              # fix unit_return only
 *   node scripts/backfill-stake-zero.js --dry-run    # report, do not write
 *   node scripts/backfill-stake-zero.js --regrade    # also clear result + return
 */
const { getValues, setValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const regrade = args.includes('--regrade');

  console.log('[backfill] Reading Performance Log...');
  const rows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!rows || rows.length < 2) {
    console.log('[backfill] Performance Log empty — nothing to do.');
    return;
  }

  let fixed = 0;
  let inspected = 0;
  const newRows = rows.map((row, idx) => {
    if (idx === 0) return row; // header
    inspected++;
    const copy = row.slice();
    const unitsRaw = parseFloat(copy[10]);
    const units = Number.isFinite(unitsRaw) ? unitsRaw : NaN;
    const ret = parseFloat(copy[17]);
    if (units === 0 && Number.isFinite(ret) && ret !== 0) {
      copy[17] = 0;
      if (regrade) {
        copy[16] = ''; // clear result so trigger12 can regrade
      }
      fixed++;
    }
    return copy;
  });

  console.log(`[backfill] Inspected ${inspected} rows, found ${fixed} stake-zero rows with phantom unit_return.`);
  if (dryRun) {
    console.log('[backfill] --dry-run set, not writing.');
    return;
  }
  if (fixed === 0) {
    console.log('[backfill] Nothing to fix.');
    return;
  }
  await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', newRows);
  console.log(`[backfill] Wrote ${newRows.length} rows back to Performance Log (${fixed} fixed${regrade ? ', results cleared for regrade' : ''}).`);
}

if (require.main === module) {
  main().catch(e => { console.error('[backfill] FAILED:', e.message); process.exit(1); });
}
