'use strict';
// CLI: node scripts/refresh-dashboard.js [--dry-run]
// R0.3 — rebuild the Sheet's Dashboard tab from Supabase (see src/dashboard.js).
// --dry-run prints the rows instead of writing the Sheet.
require('dotenv').config();
const db = require('../src/db');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const { buildDashboard, CLEAN_ERA_START_ISO } = require('../src/dashboard');

const PAGE = 1000;

async function readAll(sb, table, columns, apply) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await apply(sb.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const sb = db.getClient();
  if (!sb) throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');

  // Approved v2 rows since the clean era (graded + upcoming), same set as the weekly report.
  const perfRows = await readAll(sb, 'performance_log',
    'date, game_date, league, game, market, pick, odds, final_units, result, unit_return, approval_status, pick_regime',
    (q) => q.eq('approval_status', 'approved').eq('pick_regime', 'v2_clv').gte('date', CLEAN_ERA_START_ISO).order('id'));
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const triggerRuns = await readAll(sb, 'trigger_log', 'trigger_name, status, start_time, error_message',
    (q) => q.gte('start_time', since).order('start_time', { ascending: false }));

  const values = buildDashboard({ perfRows, triggerRuns, now: new Date() });
  console.log(`[dashboard] ${perfRows.length} approved rows, ${triggerRuns.length} job runs -> ${values.length} rows`);
  if (dryRun) { for (const r of values) console.log(r.join(' | ')); return; }

  const { clearSheet, setValues } = require('../src/sheets');
  await clearSheet(SPREADSHEET_ID, SHEETS.DASHBOARD);
  // Pad rows to a rectangle so the API never rejects a ragged range.
  const width = Math.max(...values.map(r => r.length), 1);
  await setValues(SPREADSHEET_ID, SHEETS.DASHBOARD, 'A1',
    values.map(r => [...r, ...Array(width - r.length).fill('')]));
  console.log('[dashboard] Dashboard tab rewritten');
})().catch((e) => { console.error('[dashboard] FAILED:', e.message); process.exit(1); });
