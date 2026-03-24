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

module.exports = {
  getSheetsClient,
  getValues,
  setValues,
  appendRows,
  clearSheet,
  getCell,
  setCell,
};
