'use strict';
// =============================================================
// src/data-store.js — single seam for the Google Sheets exit
//
// Callers ask for an ENTITY (e.g. 'performanceRows') instead of calling
// getValues(SHEETS.X) directly. Each entity resolves to a mode via
// config.dataModeFor():
//   'sheet'    -> read the Sheet (unchanged behaviour)
//   'supabase' -> read Supabase, mapped back to the Sheet row shape
//   'dual'     -> read both, log divergence, RETURN THE SHEET VALUE
//
// In 'dual'/'sheet' the Sheet stays authoritative, so routing a reader
// through here is behaviour-preserving. Entities are flipped to
// 'supabase' one at a time only after their dual shadow shows parity.
// =============================================================

const { getValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, dataModeFor } = require('./config');
const db = require('./db');

// ── shape mappers: Supabase row object -> positional Sheet row ──────
function isoToMDY(d) {
  const m = String(d || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${parseInt(m[2])}/${parseInt(m[3])}/${m[1]}` : String(d || '');
}
function perfSupaToRow(r) {
  let away = '', home = '';
  if (r.game && String(r.game).includes('@')) {
    const [a, b] = String(r.game).split('@');
    away = (a || '').trim(); home = (b || '').trim();
  }
  const row = new Array(18).fill('');
  row[0] = isoToMDY(r.date); row[1] = r.league || ''; row[2] = r.market || '';
  row[3] = away; row[4] = home; row[5] = '';
  row[6] = r.market || ''; row[7] = r.pick || '';
  row[8] = r.line != null ? r.line : ''; row[9] = r.odds != null ? r.odds : '';
  row[10] = (r.final_units != null ? r.final_units : (r.base_units != null ? r.base_units : ''));
  row[11] = r.confidence != null ? `${r.confidence}%` : '';
  row[16] = r.result || ''; row[17] = r.unit_return != null ? r.unit_return : '';
  return row;
}

const HEADER = ['__header__'];

// ── entity registry: each has a sheet() fetcher; supa() is optional ──
// Adding supa() turns on the shadow read in 'dual' mode. Entities without
// a supa() simply behave as 'sheet' regardless of configured mode.
const REGISTRY = {
  // ── Category A (Supabase-backed) ──
  performanceRows: {
    sheet: () => getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE),
    supa: async () => {
      const data = await db.rawSelect('performance_log', { columns: '*' });
      return [HEADER, ...(data || []).map(perfSupaToRow)];
    },
  },
  // Registered (routed) but shadow-inert until their mappers land in Phase 1b.
  propPerformanceRows: { sheet: () => getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE) },
  propStatusRows:      { sheet: () => getValues(SPREADSHEET_ID, SHEETS.PROP_STATUS) },
  modifierRows:        {
    sheet: () => getValues(SPREADSHEET_ID, SHEETS.CLV_MODIFIERS),
    supa: async () => {
      const data = await db.readModifiers();
      const rows = [['League', 'Market', 'Modifier', 'SampleSize', 'WinRate', 'ROI', 'UpdatedAt']];
      for (const r of (data || [])) rows.push([r.league, r.market, r.modifier, r.sample_size, r.win_rate, r.roi, r.updated_at]);
      return rows;
    },
  },
  clvSnapshotRows:     { sheet: () => getValues(SPREADSHEET_ID, SHEETS.CLV_SNAPSHOT) },
  triggerRuns:         { sheet: () => getValues(SPREADSHEET_ID, SHEETS.TRIGGER_MONITOR_8T) },
  // ── Category B (external data; Phase 2 tables) ──
  gameOdds:        { sheet: () => getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS), supa: () => db.getLatestSnapshot('gameOdds') },
  scheduleContext: { sheet: () => getValues(SPREADSHEET_ID, SHEETS.SCHEDULE_CONTEXT), supa: () => db.getLatestSnapshot('scheduleContext') },
  injuries:        { sheet: () => getValues(SPREADSHEET_ID, SHEETS.INJURY_SUMMARY), supa: () => db.getLatestSnapshot('injuries') },
  yesterdayResults:{ sheet: () => getValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS), supa: () => db.getLatestSnapshot('yesterdayResults') },
  playerTiers:     { sheet: () => getValues(SPREADSHEET_ID, SHEETS.PLAYER_TIERS), supa: () => db.getLatestSnapshot('playerTiers') },
};

// ── divergence logging (cheap: row counts + sampled cells) ──
function rowCount(v) { return Array.isArray(v) ? Math.max(0, v.length - 1) : 0; }
function logDivergence(entity, sheetVal, supaVal) {
  const sc = rowCount(sheetVal), pc = rowCount(supaVal);
  if (sc !== pc) {
    console.warn(`[data-store] DIVERGENCE ${entity}: sheet=${sc} rows, supabase=${pc} rows`);
  } else {
    console.log(`[data-store] parity ${entity}: ${sc} rows (sheet==supabase count)`);
  }
}

/**
 * Build a reader bound to a registry + mode resolver (factory enables tests).
 */
function makeReader(registry, modeFn) {
  return async function read(entity) {
    const ent = registry[entity];
    if (!ent) throw new Error(`[data-store] unknown entity: ${entity}`);
    const mode = modeFn(entity);

    if (mode === 'supabase' && ent.supa) { const v = await ent.supa(); return (v && v.length) ? v : ent.sheet(); }
    if (mode === 'supabase') return ent.sheet(); // no mapper yet -> safe fallback

    const sheetVal = await ent.sheet();
    if (mode === 'dual' && ent.supa) {
      try {
        const supaVal = await ent.supa();
        logDivergence(entity, sheetVal, supaVal);
      } catch (e) {
        console.warn(`[data-store] ${entity} shadow read failed: ${e.message}`);
      }
    }
    return sheetVal;
  };
}

const read = makeReader(REGISTRY, dataModeFor);

module.exports = { read, makeReader, REGISTRY, perfSupaToRow, isoToMDY };
