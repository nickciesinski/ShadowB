'use strict';
// =============================================================
// src/sheets.js — Google Sheets API wrapper
// Replaces: SpreadsheetApp in Apps Script
// =============================================================

const { google } = require('googleapis');

let _sheetsClient = null;

/**
 * Authenticate and return the Google Sheets API client.
 * Uses the GOOGLE_SERVICE_ACCOUNT_JSON environment variable.
 */
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set');
  }

  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// ── Transient-error retry ────────────────────────────────────────
// The Google Sheets backend intermittently returns 5xx ("The service is
// currently unavailable.") and 429 ("Quota exceeded") errors. A single one
// of these used to abort an entire trigger (e.g. trigger10/11 6/8–6/9). These
// are transient: retrying with exponential backoff almost always succeeds.
// Non-transient errors (e.g. "exceeds grid limits") are rethrown immediately
// so callers' existing handling — like the grid auto-expand below — still runs.

const TRANSIENT_MSG = [
  'currently unavailable', 'try again', 'rate limit', 'quota exceeded',
  'backend error', 'internal error', 'deadline exceeded',
  'timeout', 'timed out', 'socket hang up', 'network', 'econnreset',
];
const TRANSIENT_CODES_NUM = [429, 500, 502, 503, 504];
const TRANSIENT_CODES_STR = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED'];

function isTransient(err) {
  if (!err) return false;
  const numCode = Number(err.code || err.status || (err.response && err.response.status));
  if (TRANSIENT_CODES_NUM.includes(numCode)) return true;
  if (typeof err.code === 'string' && TRANSIENT_CODES_STR.includes(err.code)) return true;
  const msg = String(err.message || '').toLowerCase();
  return TRANSIENT_MSG.some(p => msg.includes(p));
}

async function withRetry(label, thunk, { tries = 4, baseMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await thunk();
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !isTransient(err)) throw err;
      const delay = baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`[sheets] ${label}: transient error (attempt ${attempt}/${tries}) — ${err.message}; retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Read all values from a sheet tab.
 * @returns {Array<Array>} 2D array of values
 */
async function getValues(spreadsheetId, sheetName, range) {
  const sheets = await getSheetsClient();
  const a1 = range ? `${sheetName}!${range}` : sheetName;
  const res = await withRetry(`getValues(${sheetName})`, () =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: a1 }));
  return res.data.values || [];
}

/**
 * Write values to a sheet tab.
 */
async function setValues(spreadsheetId, sheetName, range, values) {
  const sheets = await getSheetsClient();
  const a1 = `${sheetName}!${range}`;
  try {
    await withRetry(`setValues(${sheetName})`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: a1,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      }));
  } catch (err) {
    if (err.message && err.message.includes('exceeds grid limits')) {
      // Auto-expand grid and retry — account for write offset (e.g. A1029)
      const rowMatch = range.match(/\d+/);
      const startRow = rowMatch ? parseInt(rowMatch[0]) : 1;
      const needed = startRow + values.length + 500;
      await ensureGridRows(spreadsheetId, sheetName, needed);
      await withRetry(`setValues(${sheetName}) post-expand`, () =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range: a1,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values },
        }));
    } else {
      throw err;
    }
  }
}

/**
 * Append rows to a sheet tab.
 */
async function appendRows(spreadsheetId, sheetName, values) {
  const sheets = await getSheetsClient();
  try {
    await withRetry(`appendRows(${sheetName})`, () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: sheetName,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      }));
  } catch (err) {
    if (err.message && err.message.includes('exceeds grid limits')) {
      // Auto-expand grid and retry
      const meta = await withRetry(`appendRows(${sheetName}) meta`, () =>
        sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }));
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetName);
      const currentRows = sheetMeta ? sheetMeta.properties.gridProperties.rowCount : 0;
      await ensureGridRows(spreadsheetId, sheetName, currentRows + values.length + 500);
      await withRetry(`appendRows(${sheetName}) post-expand`, () =>
        sheets.spreadsheets.values.append({
          spreadsheetId,
          range: sheetName,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values },
        }));
    } else {
      throw err;
    }
  }
}

/**
 * Clear a sheet tab's contents (keeps formatting).
 */
async function clearSheet(spreadsheetId, sheetName) {
  const sheets = await getSheetsClient();
  await withRetry(`clearSheet(${sheetName})`, () =>
    sheets.spreadsheets.values.clear({ spreadsheetId, range: sheetName }));
}

/**
 * Get a single cell value.
 */
async function getCell(spreadsheetId, sheetName, cellA1) {
  const rows = await getValues(spreadsheetId, sheetName, cellA1);
  return rows?.[0]?.[0] ?? null;
}

/**
 * Set a single cell value.
 */
async function setCell(spreadsheetId, sheetName, cellA1, value) {
  await setValues(spreadsheetId, sheetName, cellA1, [[value]]);
}

/**
 * Ensure a sheet tab exists in the workbook. Creates it if missing.
 */
async function ensureSheet(spreadsheetId, sheetName) {
  const sheets = await getSheetsClient();
  const meta = await withRetry(`ensureSheet(${sheetName}) meta`, () =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }));
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
  if (!exists) {
    await withRetry(`ensureSheet(${sheetName}) add`, () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
      }));
    console.log(`[sheets] Created missing sheet: ${sheetName}`);
  }
}

/**
 * Ensure a sheet's grid has at least `minRows` rows.
 */
async function ensureGridRows(spreadsheetId, sheetName, minRows) {
  const sheets = await getSheetsClient();
  const meta = await withRetry(`ensureGridRows(${sheetName}) meta`, () =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }));
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheetMeta) return;

  const currentRows = sheetMeta.properties.gridProperties.rowCount;
  if (currentRows >= minRows) return;

  const sheetId = sheetMeta.properties.sheetId;
  await withRetry(`ensureGridRows(${sheetName}) expand`, () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: { sheetId, dimension: 'ROWS', length: minRows - currentRows },
        }],
      },
    }));
  console.log(`[sheets] Expanded ${sheetName} grid: ${currentRows} → ${minRows} rows`);
}

module.exports = {
  ensureSheet,
  ensureGridRows,
  trimSheet,
  getSheetsClient,
  getValues,
  setValues,
  appendRows,
  clearSheet,
  getCell,
  setCell,
  withRetry,
  isTransient,
};

/**
 * Trim a sheet to keep only the header row + the most recent `maxRows` data rows.
 */
async function trimSheet(spreadsheetId, sheetName, maxRows) {
  const all = await getValues(spreadsheetId, sheetName);
  if (all.length <= maxRows + 1) {
    try {
      const cols = all[0] ? all[0].length : 1;
      await shrinkGrid(spreadsheetId, sheetName, all.length, cols);
    } catch (e) { /* ignore */ }
    return 0;
  }

  const header = all[0] ? [all[0]] : [];
  const dataRows = all.slice(1);
  const kept = dataRows.slice(dataRows.length - maxRows); // keep most recent (bottom)
  const removed = dataRows.length - kept.length;

  await clearSheet(spreadsheetId, sheetName);
  const newData = [...header, ...kept];
  if (newData.length > 0) {
    await setValues(spreadsheetId, sheetName, 'A1', newData);
  }

  try {
    await shrinkGrid(spreadsheetId, sheetName, newData.length, newData[0] ? newData[0].length : 1);
  } catch (e) {
    console.warn(`[sheets] Grid shrink failed for ${sheetName}: ${e.message}`);
  }

  console.log(`[sheets] Trimmed ${sheetName}: removed ${removed} old rows, kept ${kept.length}`);
  return removed;
}

/**
 * Shrink a sheet's grid to exactly targetRows x targetCols.
 */
async function shrinkGrid(spreadsheetId, sheetName, targetRows, targetCols) {
  const sheets = await getSheetsClient();

  const meta = await withRetry(`shrinkGrid(${sheetName}) meta`, () =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }));
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheetMeta) return;

  const sheetId = sheetMeta.properties.sheetId;
  const currentRows = sheetMeta.properties.gridProperties.rowCount;
  const currentCols = sheetMeta.properties.gridProperties.columnCount;

  const requests = [];

  const safeRows = Math.max(targetRows + 500, 2);
  if (currentRows > safeRows) {
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: safeRows, endIndex: currentRows },
      },
    });
  }

  const safeCols = Math.max(targetCols + 2, 5);
  if (currentCols > safeCols + 10) {
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: safeCols, endIndex: currentCols },
      },
    });
  }

  if (requests.length > 0) {
    await withRetry(`shrinkGrid(${sheetName}) apply`, () =>
      sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
    const savedCells = (currentRows * currentCols) - (safeRows * Math.min(currentCols, safeCols));
    console.log(`[sheets] Shrunk ${sheetName} grid: ${currentRows}x${currentCols} → ${safeRows}x${Math.min(currentCols, safeCols)} (freed ~${savedCells} cells)`);
  }
}
