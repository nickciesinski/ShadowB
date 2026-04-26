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

/**
 * Read all values from a sheet tab.
 * Equivalent to: sheet.getRange(1,1,sheet.getLastRow(),sheet.getLastColumn()).getValues()
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName  - The tab name (e.g. 'PlayerStats')
 * @param {string} [range]    - Optional A1 notation (defaults to entire sheet)
 * @returns {Array<Array>}    - 2D array of values
 */
async function getValues(spreadsheetId, sheetName, range) {
  const sheets = await getSheetsClient();
  const a1 = range ? `${sheetName}!${range}` : sheetName;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: a1,
  });
  return res.data.values || [];
}

/**
 * Write values to a sheet tab.
 * Equivalent to: sheet.getRange(row, col, numRows, numCols).setValues(data)
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {string} range       - A1 notation (e.g. 'A1', 'A2:Z100')
 * @param {Array<Array>} values - 2D array of values
 */
async function setValues(spreadsheetId, sheetName, range, values) {
  const sheets = await getSheetsClient();
  const a1 = `${sheetName}!${range}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

/**
 * Append rows to a sheet tab.
 * Equivalent to: sheet.appendRow(rowData)
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {Array<Array>} values - Rows to append
 */
async function appendRows(spreadsheetId, sheetName, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

/**
 * Clear a sheet tab's contents (keeps formatting).
 * Equivalent to: sheet.clearContents()
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 */
async function clearSheet(spreadsheetId, sheetName) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: sheetName,
  });
}

/**
 * Get a single cell value.
 * Equivalent to: sheet.getRange(row, col).getValue()
 */
async function getCell(spreadsheetId, sheetName, cellA1) {
  const rows = await getValues(spreadsheetId, sheetName, cellA1);
  return rows?.[0]?.[0] ?? null;
}

/**
 * Set a single cell value.
 * Equivalent to: sheet.getRange(row, col).setValue(value)
 */
async function setCell(spreadsheetId, sheetName, cellA1, value) {
  await setValues(spreadsheetId, sheetName, cellA1, [[value]]);
}

/**
 * Ensure a sheet tab exists in the workbook. Creates it if missing.
 */
async function ensureSheet(spreadsheetId, sheetName) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    console.log(`[sheets] Created missing sheet: ${sheetName}`);
  }
}

module.exports = {
  ensureSheet,
  trimSheet,
  getSheetsClient,
  getValues,
  setValues,
  appendRows,
  clearSheet,
  getCell,
  setCell,
};

/**
 * Trim a sheet to keep only the header row + the most recent `maxRows` data rows.
 * Reads the sheet, keeps header + last maxRows, clears, rewrites, then SHRINKS
 * the grid to reclaim cells from the 10M workbook limit.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} maxRows - Maximum data rows to keep (excludes header)
 * @returns {number} - Number of rows removed
 */
async function trimSheet(spreadsheetId, sheetName, maxRows) {
  const all = await getValues(spreadsheetId, sheetName);
  if (all.length <= maxRows + 1) {
    // No rows to trim, but still shrink grid if oversized from prior runs
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

  // Shrink the grid to reclaim cells from the workbook 10M limit.
  // clearSheet only removes values; the grid rows/columns stay allocated.
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
 * Deletes excess rows and columns that waste the 10M cell budget.
 */
async function shrinkGrid(spreadsheetId, sheetName, targetRows, targetCols) {
  const sheets = await getSheetsClient();

  // Get sheet ID from name
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheetMeta) return;

  const sheetId = sheetMeta.properties.sheetId;
  const currentRows = sheetMeta.properties.gridProperties.rowCount;
  const currentCols = sheetMeta.properties.gridProperties.columnCount;

  const requests = [];

  // Keep at least 1 row and data + small buffer
  const safeRows = Math.max(targetRows + 500, 2);
  if (currentRows > safeRows) {
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: safeRows, endIndex: currentRows },
      },
    });
  }

  // Keep at least data cols + small buffer
  const safeCols = Math.max(targetCols + 2, 5);
  if (currentCols > safeCols + 10) {
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: safeCols, endIndex: currentCols },
      },
    });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    const savedCells = (currentRows * currentCols) - (safeRows * Math.min(currentCols, safeCols));
    console.log(`[sheets] Shrunk ${sheetName} grid: ${currentRows}x${currentCols} → ${safeRows}x${Math.min(currentCols, safeCols)} (freed ~${savedCells} cells)`);
  }
}
