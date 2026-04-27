'use strict';
// =============================================================
// src/backfill-grades.js — One-time backfill of grading data
// from Sheets Performance Log → Supabase performance_log
//
// Usage: node src/backfill-grades.js [--dry-run]
// Requires: GOOGLE_SERVICE_ACCOUNT_JSON, SUPABASE_URL, SUPABASE_KEY
// =============================================================

const { getValues } = require('./sheets');
const db = require('./db');
const { SPREADSHEET_ID, SHEETS } = require('./config');

const DRY_RUN = process.argv.includes('--dry-run');

async function backfillGrades() {
  console.log(`[backfill] Starting grade backfill${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  if (!db.isEnabled()) {
    console.error('[backfill] Supabase not configured — set SUPABASE_URL and SUPABASE_KEY');
    process.exit(1);
  }

  // Read the full Performance Log from Sheets
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) {
    console.log('[backfill] Performance Log is empty');
    return;
  }

  console.log(`[backfill] Performance Log has ${perfRows.length - 1} data rows`);

  // Collect all graded rows
  // Columns: 0:date, 1:league, 2:market, 3:away, 4:home, 7:pick, 9:odds,
  //          16:result(W/L/P), 17:unit_return
  const gradedRows = [];
  let skipped = 0;

  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 17) continue;

    const result = (row[16] || '').toString().trim();
    if (result !== 'W' && result !== 'L' && result !== 'P') {
      skipped++;
      continue;
    }

    const rawDate = String(row[0] || '').trim();
    // Convert MM/DD/YYYY → YYYY-MM-DD
    const dbDate = rawDate.replace(/(\d+)\/(\d+)\/(\d+)/, (_, m, d, y) => {
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    });

    const league = (row[1] || '').trim();
    const awayTeam = (row[3] || '').trim();
    const homeTeam = (row[4] || '').trim();
    const market = (row[2] || '').trim();
    const pick = (row[7] || '').trim();
    const unitReturn = parseFloat(row[17]) || 0;
    const odds = parseInt(row[9]) || null;

    // CLV grade column — check col 18 if it exists
    let clvGrade = null;
    if (row[18] !== undefined && row[18] !== '') {
      const parsed = parseFloat(row[18]);
      if (!isNaN(parsed)) clvGrade = parsed;
    }

    gradedRows.push({
      date: dbDate,
      league,
      game: `${awayTeam} @ ${homeTeam}`,
      market,
      pick,
      result,
      units_returned: parseFloat(unitReturn.toFixed(2)),
      clv_grade: clvGrade,
    });
  }

  console.log(`[backfill] Found ${gradedRows.length} graded rows, ${skipped} ungraded/skipped`);

  if (DRY_RUN) {
    console.log('[backfill] DRY RUN — showing first 5 rows:');
    gradedRows.slice(0, 5).forEach((r, i) => console.log(`  ${i}: ${JSON.stringify(r)}`));
    console.log('[backfill] DRY RUN complete — no Supabase writes made');
    return;
  }

  // Batch update in chunks of 50 to avoid overwhelming Supabase
  const BATCH_SIZE = 50;
  let totalUpdated = 0;
  let totalFailed = 0;

  for (let start = 0; start < gradedRows.length; start += BATCH_SIZE) {
    const batch = gradedRows.slice(start, start + BATCH_SIZE);
    const sb = db.getClient();

    for (const row of batch) {
      const { error, count } = await sb.from('performance_log')
        .update({
          result: row.result,
          units_returned: row.units_returned,
          clv_grade: row.clv_grade,
        })
        .eq('date', row.date)
        .eq('league', row.league)
        .eq('game', row.game)
        .eq('market', row.market)
        .eq('pick', row.pick);

      if (error) {
        totalFailed++;
        if (totalFailed <= 10) {
          console.warn(`[backfill] Failed: ${row.date} ${row.league} ${row.game} ${row.market} ${row.pick} — ${error.message}`);
        }
      } else {
        totalUpdated++;
      }
    }

    const pct = Math.round(((start + batch.length) / gradedRows.length) * 100);
    console.log(`[backfill] Progress: ${start + batch.length}/${gradedRows.length} (${pct}%) — ${totalUpdated} updated, ${totalFailed} failed`);
  }

  console.log(`[backfill] DONE — ${totalUpdated} rows updated, ${totalFailed} failed out of ${gradedRows.length} graded`);
}

backfillGrades().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
