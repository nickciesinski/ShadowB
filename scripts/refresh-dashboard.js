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

  const { getSheetsClient, withRetry } = require('../src/sheets');
  const sheets = await getSheetsClient();
  const tab = SHEETS.DASHBOARD;
  // The March Apps Script layout left merged cells behind; a value written into
  // a merged cell is hidden, so unmerge the whole tab before writing.
  const meta = await withRetry('dashboard meta', () =>
    sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' }));
  const sheet = meta.data.sheets.find(s => s.properties.title === tab);
  if (!sheet) throw new Error(`no "${tab}" tab in the spreadsheet`);
  const { sheetId } = sheet.properties;
  await withRetry('dashboard unmerge', () => sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ unmergeCells: { range: { sheetId } } }] } }));
  await withRetry('dashboard clear', () =>
    sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: tab }));
  // Pad rows to a rectangle; RAW so "+4.1%" stays text instead of becoming 0.041.
  const width = Math.max(...values.map(r => r.length), 1);
  const padded = values.map(r => [...r, ...Array(width - r.length).fill('')]);
  const { ensureGridRows } = require('../src/sheets');
  await ensureGridRows(SPREADSHEET_ID, tab, padded.length + 10);
  await withRetry('dashboard write', () => sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID,
    range: `${tab}!A1`, valueInputOption: 'RAW', requestBody: { values: padded } }));
  console.log('[dashboard] Dashboard tab rewritten');
})().catch((e) => { console.error('[dashboard] FAILED:', e.message); process.exit(1); });
