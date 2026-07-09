'use strict';
/**
 * scripts/audit-unit-return.js — backfill null unit_return in Supabase
 *
 * Context: unit_return was computed at grading time but never included in
 * the Supabase dual-write until 2026-07-07 (commit 554fea1). Every graded
 * row written before then has unit_return = null, so any ROI computation
 * that reads performance_log directly (the weekly threshold tuner, since
 * its 7/7 fix) silently sees 0% ROI across that history. A 30/60-day
 * lookback window straddling 7/7 is quietly undercounting.
 *
 * Fix: unit_return is fully derivable from columns Supabase already has —
 *   W → final_units × (odds > 0 ? odds/100 : 100/|odds|)
 *   L → -final_units
 *   P (push/tie) → 0
 * (Same math as the grading path in predictions.js and the webapp's
 * calcProfit.)
 *
 * Usage:
 *   node scripts/audit-unit-return.js            # dry run: report only
 *   node scripts/audit-unit-return.js --apply    # write the backfill
 *
 * Idempotent: only touches rows where unit_return IS NULL and result is a
 * graded value, so re-running is safe and post-7/7 rows are never modified.
 */

const db = require('../src/db');

const PAGE = 1000;
const APPLY = process.argv.includes('--apply');

function computeUnitReturn(result, odds, units) {
  const o = parseFloat(odds);
  const u = parseFloat(units);
  if (isNaN(u)) return null;
  const r = String(result || '').trim().toUpperCase();
  if (r === 'W') {
    if (isNaN(o) || o === 0) return null; // can't price a win without odds
    return +(u * (o > 0 ? o / 100 : 100 / Math.abs(o))).toFixed(4);
  }
  if (r === 'L') return +(-u).toFixed(4);
  if (r === 'P' || r === 'PUSH' || r === 'T') return 0;
  return null; // ungraded or unknown result — leave alone
}

async function main() {
  if (!db.isEnabled()) {
    console.error('[audit-unit-return] Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Nothing to do.');
    process.exit(1);
  }
  const sb = db.getClient();

  console.log(`[audit-unit-return] Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (report only — pass --apply to write)'}`);

  let offset = 0;
  let scanned = 0, fixable = 0, updated = 0, unpriceable = 0, failed = 0;
  const byLeague = {};

  for (;;) {
    const { data, error } = await sb.from('performance_log')
      .select('date, league, game, market, pick, odds, final_units, result, unit_return')
      .is('unit_return', null)
      .in('result', ['W', 'L', 'P'])
      .order('date', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error('[audit-unit-return] Query failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      const ur = computeUnitReturn(row.result, row.odds, row.final_units);
      if (ur === null) {
        unpriceable++;
        if (unpriceable <= 5) {
          console.warn(`[audit-unit-return] Unpriceable (missing odds/units): ${row.date} ${row.league} ${row.game} ${row.market} ${row.pick} result=${row.result} odds=${row.odds} units=${row.final_units}`);
        }
        continue;
      }
      fixable++;
      byLeague[row.league] = (byLeague[row.league] || 0) + 1;

      if (APPLY) {
        const { error: upErr } = await sb.from('performance_log')
          .update({ unit_return: ur })
          .eq('date', row.date)
          .eq('league', row.league)
          .eq('game', row.game)
          .eq('market', row.market)
          .eq('pick', row.pick)
          .is('unit_return', null); // extra guard: never overwrite a real value
        if (upErr) {
          failed++;
          if (failed <= 5) console.warn(`[audit-unit-return] Update failed: ${upErr.message}`);
        } else {
          updated++;
        }
      }
    }

    if (data.length < PAGE) break;
    // When applying, fixed rows drop out of the NULL filter, so re-query
    // from the same offset; when dry-running, advance.
    if (!APPLY) offset += PAGE;
  }

  console.log('\n[audit-unit-return] ===== SUMMARY =====');
  console.log(`Rows with graded result + null unit_return: ${scanned}`);
  console.log(`Backfillable: ${fixable} (by league: ${JSON.stringify(byLeague)})`);
  console.log(`Unpriceable (missing odds/units — left null): ${unpriceable}`);
  if (APPLY) {
    console.log(`Updated: ${updated}, Failed: ${failed}`);
  } else {
    console.log('DRY RUN — nothing written. Re-run with --apply to backfill.');
  }
  if (scanned === 0) {
    console.log('Nothing to backfill — either already done or all pre-7/7 rows were regraded.');
  }
}

main().catch(e => { console.error('[audit-unit-return] FATAL:', e.message); process.exit(1); });
