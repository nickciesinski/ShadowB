'use strict';
// =============================================================
// src/dashboard.js — rebuild the Sheet's Dashboard tab from Supabase (R0.3)
//
// 2026-10-26. The Dashboard body was last written by the Apps Script on
// 2026-03-24; since the move to GitHub Actions only the A1 header
// (monitoring.refreshDashboardHeader) was ever refreshed, so the page showed
// March numbers under a live timestamp. This builds the whole tab from the
// ledger instead. Pure: rows in, 2D array out. scripts/refresh-dashboard.js
// does the reads and the write.
//
// Numbers use the clean-era report's definition of "staked": pick_regime
// 'v2_clv' (the old re-decide-every-morning v1 rows describe a process that no
// longer exists), approval_status 'approved', graded W/L/P, ROI = return /
// units staked. Report-only — nothing
// in the pick, stake or grade path reads this.
// =============================================================

const CLEAN_ERA_START_ISO = '2026-06-03';
const LEAGUES = ['MLB', 'NBA', 'NFL', 'NHL'];
const MARKETS = ['moneyline', 'spread', 'total'];
const TZ = 'America/Los_Angeles';

/** 'YYYY-MM-DD' for a Date in Pacific time. */
function ptDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** "Mon 10/26 9:05 PM" in Pacific time. */
function ptStamp(d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit' }).format(d).replace(',', '');
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function marketOf(r) {
  const m = String(r.market || '').toLowerCase();
  if (m.includes('total') || m === 'over' || m === 'under') return 'total';
  if (m.includes('spread')) return 'spread';
  if (m.includes('money') || m === 'h2h') return 'moneyline';
  return m;
}

const isApproved = (r) => String(r.approval_status || '').trim().toLowerCase() === 'approved'
  && r.pick_regime === 'v2_clv';

/** Record / win% / units / ROI over staked, graded rows. */
function summarize(rows) {
  let w = 0, l = 0, p = 0, staked = 0, ret = 0;
  for (const r of rows) {
    const res = String(r.result || '').toUpperCase();
    if (res !== 'W' && res !== 'L' && res !== 'P') continue;
    if (res === 'W') w++; else if (res === 'L') l++; else p++;
    staked += Number(r.final_units) || 0;
    ret += Number(r.unit_return) || 0;
  }
  const decided = w + l;
  return {
    record: `${w}-${l}${p ? '-' + p : ''}`,
    winPct: decided ? `${(100 * w / decided).toFixed(1)}%` : '—',
    units: `${ret >= 0 ? '+' : ''}${ret.toFixed(2)}`,
    roi: staked > 0 ? `${ret >= 0 ? '+' : ''}${(100 * ret / staked).toFixed(1)}%` : '—',
    n: w + l + p,
  };
}

const perfRow = (label, s) => [label, s.record, s.winPct, s.units, s.roi];

/**
 * @param {Object} input
 *   perfRows    performance_log rows (date, game_date, league, game, market, pick,
 *               odds, final_units, result, unit_return, approval_status, pick_regime)
 *   triggerRuns trigger_log rows (trigger_name, status, start_time, error_message)
 *   now         Date
 * @returns {Array<Array>} values for the Dashboard tab, A1 down
 */
function buildDashboard({ perfRows = [], triggerRuns = [], now = new Date() } = {}) {
  const today = ptDate(now);
  const out = [];
  out.push([`SHADOW BETS DASHBOARD — ${ptStamp(now)} PT`]);
  out.push([]);

  // ── Upcoming picks: approved and not yet graded, today onward ──
  const upcoming = perfRows
    .filter(r => isApproved(r) && !r.result && String(r.game_date || r.date || '') >= today)
    .sort((a, b) => String(a.game_date || a.date).localeCompare(String(b.game_date || b.date))
      || String(a.league).localeCompare(String(b.league)) || String(a.game).localeCompare(String(b.game)));
  out.push(['UPCOMING STAKED PICKS']);
  if (upcoming.length === 0) {
    out.push(['No approved picks waiting right now']);
  } else {
    out.push(['Game date', 'League', 'Game', 'Market', 'Pick', 'Odds', 'Units']);
    for (const r of upcoming) {
      out.push([String(r.game_date || r.date || ''), r.league || '', r.game || '', marketOf(r), r.pick || '',
        r.odds != null ? String(r.odds) : '', r.final_units != null ? Number(r.final_units).toFixed(2) : '']);
    }
  }
  out.push([]);

  // ── Staked performance ──
  const staked = perfRows.filter(r => isApproved(r) && String(r.date || '') >= CLEAN_ERA_START_ISO);
  const since = (days) => staked.filter(r => String(r.date) >= addDaysISO(today, -days));
  out.push(['STAKED PERFORMANCE (approved bets)']);
  out.push(['Period', 'Record', 'Win %', 'Units', 'ROI']);
  out.push(perfRow('Last 7 days', summarize(since(7))));
  out.push(perfRow('Last 30 days', summarize(since(30))));
  out.push(perfRow(`Since ${CLEAN_ERA_START_ISO} (clean era)`, summarize(staked)));
  out.push([]);
  out.push(['League (clean era)', 'Record', 'Win %', 'Units', 'ROI']);
  for (const lg of LEAGUES) {
    const s = summarize(staked.filter(r => r.league === lg));
    if (s.n) out.push(perfRow(lg, s));
  }
  out.push([]);
  out.push(['Market (clean era)', 'Record', 'Win %', 'Units', 'ROI']);
  for (const mk of MARKETS) {
    const s = summarize(staked.filter(r => marketOf(r) === mk));
    if (s.n) out.push(perfRow(mk, s));
  }
  out.push([]);

  // ── System health: latest run of each job ──
  const latest = new Map();
  for (const t of triggerRuns) {
    if (!t || !t.trigger_name || !t.start_time) continue;
    const prev = latest.get(t.trigger_name);
    if (!prev || String(t.start_time) > String(prev.start_time)) latest.set(t.trigger_name, t);
  }
  out.push(['SYSTEM HEALTH (latest run of each job, last 3 days)']);
  if (latest.size === 0) {
    out.push(['No job runs logged in the last 3 days — check GitHub Actions']);
  } else {
    out.push(['Job', 'Last run (PT)', 'Status', 'Error']);
    const names = [...latest.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const name of names) {
      const t = latest.get(name);
      out.push([name, ptStamp(new Date(t.start_time)), String(t.status || ''),
        String(t.error_message || '').slice(0, 200)]);
    }
  }
  out.push([]);
  out.push([`Last refreshed: ${ptStamp(now)} PT · built from Supabase by scripts/refresh-dashboard.js`]);
  return out;
}

module.exports = { buildDashboard, summarize, marketOf, ptDate, CLEAN_ERA_START_ISO };
