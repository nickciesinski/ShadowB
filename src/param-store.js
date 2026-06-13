'use strict';
// =============================================================
// src/param-store.js — file-backed model parameter store
//
// Replaces the Google Sheet as the source of truth for model
// weights/params. Reads & writes config/model-params.<LEAGUE>.json.
//
// To keep the rest of the codebase untouched, getRows()/setRows()
// speak the SAME 3-column shape the Weights_* sheet used
// ([market, key, weight]), so existing parseWeightRows() logic and
// optimizer row-walking code work without changes.
// =============================================================

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

function leagueFromAny(x) {
  const s = String(x || '').toUpperCase();
  if (s.includes('NBA')) return 'NBA';
  if (s.includes('NFL')) return 'NFL';
  if (s.includes('NHL')) return 'NHL';
  return 'MLB'; // default (also matches 'Weights_MLB' / WEIGHTS)
}

function fileFor(league) {
  return path.join(CONFIG_DIR, `model-params.${leagueFromAny(league)}.json`);
}

/** Load the structured params object for a league. */
function load(league) {
  const fp = fileFor(league);
  const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
  obj.params = obj.params || {};
  obj.moneyline = obj.moneyline || {};
  obj.spread = obj.spread || {};
  obj.total = obj.total || {};
  return obj;
}

/** Persist a structured params object for a league (pretty JSON). */
function save(league, obj) {
  const fp = fileFor(league);
  const existing = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : {};
  const out = {
    league: leagueFromAny(league),
    _comment: existing._comment ||
      'Single source of truth for model weights & params. Edit by hand or let the optimizer tune it. Hard rules live in config/rules.js and are never written here.',
    params: obj.params || {},
    moneyline: obj.moneyline || {},
    spread: obj.spread || {},
    total: obj.total || {},
  };
  fs.writeFileSync(fp, JSON.stringify(out, null, 2) + '\n');
}

/** Flatten structured params into [market, key, weight] rows (incl. header). */
function getRows(league) {
  const o = load(league);
  const rows = [['market', 'key', 'weight']];
  for (const [k, v] of Object.entries(o.params)) rows.push(['', k, v]);
  for (const market of ['moneyline', 'spread', 'total']) {
    for (const [k, v] of Object.entries(o[market] || {})) rows.push([market, k, v]);
  }
  return rows;
}

/** Parse [market, key, weight] rows back into structured form and save. */
function setRows(league, rows) {
  const o = { params: {}, moneyline: {}, spread: {}, total: {} };
  if (Array.isArray(rows)) {
    const start = (rows[0] && /market/i.test(String(rows[0][0] || '')) && /key/i.test(String(rows[0][1] || ''))) ? 1 : 0;
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [];
      const market = String(row[0] || '').trim().toLowerCase();
      const key = String(row[1] || '').trim();
      const val = parseFloat(row[2]);
      if (!key || !isFinite(val)) continue;
      if (key.startsWith('param_')) o.params[key] = val;
      else if (market === 'moneyline' || market === 'spread' || market === 'total') o[market][key] = val;
    }
  }
  save(league, o);
}

module.exports = { load, save, getRows, setRows, leagueFromAny, fileFor };
