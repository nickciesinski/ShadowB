'use strict';
/**
 * src/signal-health.js — persist per-run signal coverage stats
 *
 * Problem: coverage facts like "MLB pitcher lookup hit 14/15 games" or
 * "NHL goalie data covered 8/10 games" only exist as console.log lines
 * inside the prediction run, so the daily health check (trigger16) can't
 * see them. This module writes them to a small Signal_Health sheet so
 * the season-start verification and coverage alerts have real data.
 *
 * Volume is tiny (a few rows/day in season); registered in monitoring.js
 * TRIM_TARGETS so it can never contribute to the 10M-cell problem.
 * All writes are non-fatal — signal health must never break predictions.
 */

const { getValues, appendRows, ensureSheet } = require('./sheets');
const { SPREADSHEET_ID } = require('./config');

const SIGNAL_HEALTH_SHEET = 'Signal_Health';
const HEADER = ['Timestamp', 'League', 'Signal', 'Coverage', 'Detail'];

/**
 * Record one signal-health observation.
 * @param {Object} o
 * @param {string} o.league   'MLB' | 'NHL' | ...
 * @param {string} o.signal   e.g. 'pitcher_coverage', 'goalie_coverage'
 * @param {number} o.coverage 0–1 fraction of games the signal covered
 * @param {string} [o.detail] free text, e.g. '14/15 games'
 */
async function recordSignalHealth({ league, signal, coverage, detail = '' }) {
  try {
    await ensureSheet(SPREADSHEET_ID, SIGNAL_HEALTH_SHEET);
    // Write the header once if the sheet is empty (ensureSheet only creates the tab)
    const existing = await getValues(SPREADSHEET_ID, SIGNAL_HEALTH_SHEET);
    if (!existing || existing.length === 0) {
      await appendRows(SPREADSHEET_ID, SIGNAL_HEALTH_SHEET, [HEADER]);
    }
    await appendRows(SPREADSHEET_ID, SIGNAL_HEALTH_SHEET, [[
      new Date().toISOString(), league, signal,
      typeof coverage === 'number' ? coverage.toFixed(3) : '',
      detail,
    ]]);
    console.log(`[signal-health] ${league} ${signal}: ${(coverage * 100).toFixed(0)}% (${detail})`);
  } catch (err) {
    console.warn(`[signal-health] Failed to record ${league}/${signal} (non-fatal):`, err.message);
  }
}

/**
 * Read the most recent observation per (league, signal).
 * @returns {Map<string, {ts:Date, coverage:number|null, detail:string}>}
 *          keyed `${LEAGUE}|${signal}`
 */
async function readLatestSignalHealth() {
  const map = new Map();
  try {
    const rows = await getValues(SPREADSHEET_ID, SIGNAL_HEALTH_SHEET);
    if (!rows || rows.length < 2) return map;
    for (let i = 1; i < rows.length; i++) {
      const [tsRaw, league, signal, covRaw, detail] = rows[i];
      const ts = new Date(tsRaw);
      if (isNaN(ts.getTime()) || !league || !signal) continue;
      const key = `${String(league).toUpperCase()}|${signal}`;
      const prev = map.get(key);
      if (!prev || ts > prev.ts) {
        const coverage = covRaw === '' || covRaw == null ? null : parseFloat(covRaw);
        map.set(key, { ts, coverage: isNaN(coverage) ? null : coverage, detail: detail || '' });
      }
    }
  } catch (err) {
    console.warn('[signal-health] Read failed (non-fatal):', err.message);
  }
  return map;
}

module.exports = { recordSignalHealth, readLatestSignalHealth, SIGNAL_HEALTH_SHEET };
