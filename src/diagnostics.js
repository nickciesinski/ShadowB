'use strict';
// =============================================================
// src/diagnostics.js — System health checks
// Replaces: DiagnosticTests (Apps Script)
// Usage: node src/diagnostics.js
// =============================================================

require('dotenv').config();
const { validateConfig, SPREADSHEET_ID, SHEETS, ODDS_API_KEY, ODDS_API_BASE } = require('./config');
const { getSheetsClient, getValues } = require('./sheets');

async function runDiagnostics() {
  console.log('='.repeat(60));
  console.log('Shadow Bets — System Diagnostics');
  console.log('='.repeat(60));
  let passed = 0;
  let failed = 0;

  // 1. Config validation
  try {
    validateConfig();
    console.log('✅ Config: All required environment variables present');
    passed++;
  } catch (err) {
    console.error('❌ Config:', err.message);
    failed++;
  }

  // 2. Google Sheets connection
  try {
    const client = await getSheetsClient();
    const testRange = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const title = testRange.data.properties?.title || 'unknown';
    console.log(`✅ Google Sheets: Connected to "${title}"`);
    passed++;
  } catch (err) {
    console.error('❌ Google Sheets:', err.message);
    failed++;
  }

  // 3. Read a sheet tab
  try {
    const rows = await getValues(SPREADSHEET_ID, SHEETS.CONFIG, 'A1:B5');
    console.log(`✅ Sheets Read: Config tab has ${rows.length} rows`);
    passed++;
  } catch (err) {
    console.error('❌ Sheets Read:', err.message);
    failed++;
  }

  // 4. Odds API connection
  try {
    const url = `${ODDS_API_BASE}/sports?apiKey=${ODDS_API_KEY}&all=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sports = await res.json();
    console.log(`✅ Odds API: Connected, ${sports.length} sports available`);
    passed++;
  } catch (err) {
    console.error('❌ Odds API:', err.message);
    failed++;
  }

  // 5. ESPN API connection
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('✅ ESPN API: Connected');
    passed++;
  } catch (err) {
    console.error('❌ ESPN API:', err.message);
    failed++;
  }

  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

runDiagnostics().catch(err => {
  console.error('Diagnostics crashed:', err);
  process.exit(1);
});
