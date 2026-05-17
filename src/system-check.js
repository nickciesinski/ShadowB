'use strict';
// =============================================================
// src/system-check.js — Manual system health check + performance report
//
// Sends a single email with two sections:
//   Part 1: System Health Check (triggers, data freshness, Supabase, grading)
//   Part 2: Performance Report (3/7/15/30 day windows by league, bet type, props)
//
// Usage: node src/system-check.js
// Dispatch: GitHub Actions workflow_dispatch (system-check.yml)
// =============================================================

const { SPREADSHEET_ID, SHEETS, GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENTS } = require('./config');
const { getValues } = require('./sheets');
const db = require('./db');
const nodemailer = require('nodemailer');

const WINDOWS = [3, 7, 15, 30];

// ── Helpers ─────────────────────────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function parseSheetDate(raw) {
  const parts = String(raw || '').trim().match(/(\d+)\/(\d+)\/(\d+)/);
  if (!parts) return null;
  return new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function pct(num, denom) {
  if (!denom) return '—';
  return ((num / denom) * 100).toFixed(1) + '%';
}

function signedNum(n) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function colorVal(n) {
  if (n == null || isNaN(n)) return '#666';
  return n >= 0 ? '#27ae60' : '#e74c3c';
}

// ── Part 1: System Health Check ─────────────────────────────────

async function runHealthCheck() {
  const checks = [];

  // 1a. Trigger execution status (last 24h)
  let triggerData = [];
  try {
    const monitorRows = await getValues(SPREADSHEET_ID, SHEETS.TRIGGER_MONITOR);
    const cutoff = daysAgo(1);
    if (monitorRows && monitorRows.length > 1) {
      triggerData = monitorRows.slice(1).filter(row => {
        const ts = new Date(row[0]);
        return !isNaN(ts.getTime()) && ts >= cutoff;
      }).map(row => ({
        name: row[1] || '',
        status: row[2] || '',
        duration: row[5] || '',
        error: row[7] || '',
        time: row[0] || '',
      }));
    }
  } catch (e) {
    console.warn('[check] Trigger_Monitor read failed:', e.message);
  }

  // Fallback to Supabase trigger_log
  if (triggerData.length < 3 && db.isEnabled()) {
    try {
      const dbRuns = await db.getRecentTriggerRuns(24);
      if (dbRuns && dbRuns.length > 0) {
        const existingNames = new Set(triggerData.map(t => t.name));
        for (const row of dbRuns) {
          if (!existingNames.has(row.trigger_name)) {
            triggerData.push({
              name: row.trigger_name || '',
              status: row.status || '',
              duration: row.duration_sec != null ? String(row.duration_sec) : '',
              error: row.error_message || '',
              time: row.start_time || '',
            });
          }
        }
      }
    } catch (e) {
      console.warn('[check] Supabase trigger_log fallback failed:', e.message);
    }
  }

  const expectedDaily = [
    'trigger1', 'trigger2', 'trigger3', 'trigger4',
    'trigger6', 'trigger7', 'trigger8', 'trigger9',
    'trigger10', 'trigger11', 'trigger12', 'trigger14', 'trigger16',
  ];
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 1) expectedDaily.push('trigger13'); // runs Mon 01:00 UTC

  const runMap = {};
  for (const t of triggerData) {
    if (!runMap[t.name] || t.status === 'FAILED') runMap[t.name] = t;
  }

  const triggerPassed = [];
  const triggerFailed = [];
  const triggerMissing = [];
  for (const name of expectedDaily) {
    const run = runMap[name];
    if (!run) triggerMissing.push(name);
    else if (run.status === 'FAILED') triggerFailed.push(run);
    else triggerPassed.push(run);
  }

  checks.push({
    section: 'Trigger Status (24h)',
    status: triggerFailed.length === 0 && triggerMissing.length === 0 ? 'ok' : 'warn',
    detail: `${triggerPassed.length} passed, ${triggerFailed.length} failed, ${triggerMissing.length} missing`,
    passed: triggerPassed,
    failed: triggerFailed,
    missing: triggerMissing,
  });

  // 1b. Data freshness — check key sheets have recent data
  const freshnessChecks = [
    { name: 'Today_Odds', sheet: SHEETS.GAME_ODDS, dateCol: 0 },
    { name: 'Performance Log', sheet: SHEETS.PERFORMANCE, dateCol: 0 },
    { name: 'Player_Props', sheet: SHEETS.PLAYER_PROPS, dateCol: 0 },
    { name: 'Prop_Performance', sheet: SHEETS.PROP_PERFORMANCE, dateCol: 0 },
  ];

  const freshResults = [];
  for (const fc of freshnessChecks) {
    try {
      const rows = await getValues(SPREADSHEET_ID, fc.sheet);
      const rowCount = rows ? rows.length - 1 : 0;
      let latestDate = null;
      if (rows && rows.length > 1) {
        // Check last 50 rows for most recent date
        const tail = rows.slice(-50);
        for (const row of tail) {
          const d = parseSheetDate(row[fc.dateCol]) || new Date(row[fc.dateCol]);
          if (d && !isNaN(d.getTime()) && (!latestDate || d > latestDate)) latestDate = d;
        }
      }
      const stale = !latestDate || latestDate < daysAgo(2);
      freshResults.push({ name: fc.name, rows: rowCount, latest: latestDate, stale });
    } catch (e) {
      freshResults.push({ name: fc.name, rows: 0, latest: null, stale: true, error: e.message });
    }
  }

  const staleCount = freshResults.filter(f => f.stale).length;
  checks.push({
    section: 'Data Freshness',
    status: staleCount === 0 ? 'ok' : 'warn',
    detail: staleCount === 0 ? 'All key sheets have recent data' : `${staleCount} sheet(s) may be stale`,
    items: freshResults,
  });

  // 1c. Grading pipeline — ungraded picks older than 48h
  let ungradedCount = 0;
  let totalPicks = 0;
  try {
    const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
    if (perfRows && perfRows.length > 1) {
      totalPicks = perfRows.length - 1;
      const cutoff48h = daysAgo(2);
      for (let i = 1; i < perfRows.length; i++) {
        const row = perfRows[i];
        const result = (row[16] || '').toString().trim();
        if (result !== 'W' && result !== 'L' && result !== 'P') {
          const d = parseSheetDate(row[0]);
          if (d && d < cutoff48h) ungradedCount++;
        }
      }
    }
  } catch (e) {
    console.warn('[check] Performance Log read failed:', e.message);
  }

  checks.push({
    section: 'Grading Pipeline',
    status: ungradedCount === 0 ? 'ok' : ungradedCount > 20 ? 'error' : 'warn',
    detail: ungradedCount === 0
      ? `All picks graded (${totalPicks} total in log)`
      : `${ungradedCount} ungraded picks older than 48h (${totalPicks} total)`,
  });

  // 1d. Supabase connectivity
  let supabaseStatus = 'ok';
  let supabaseDetail = '';
  if (!db.isEnabled()) {
    supabaseStatus = 'warn';
    supabaseDetail = 'Supabase not configured';
  } else {
    try {
      const modifiers = await db.readModifiers();
      const modCount = Object.keys(modifiers).length;
      const calibration = await db.getConfidenceCalibration();
      const calCount = (calibration || []).length;
      supabaseDetail = `Connected — ${modCount} modifiers, ${calCount} calibration buckets`;
    } catch (e) {
      supabaseStatus = 'error';
      supabaseDetail = `Connection failed: ${e.message}`;
    }
  }

  checks.push({
    section: 'Supabase',
    status: supabaseStatus,
    detail: supabaseDetail,
  });

  // 1e. Optimization recency — check CLV_Modifiers and Calibration_Data
  const optChecks = [];
  for (const { name, sheet } of [
    { name: 'CLV_Modifiers', sheet: SHEETS.CLV_MODIFIERS },
    { name: 'Calibration_Data', sheet: SHEETS.CALIBRATION_DATA },
  ]) {
    try {
      const rows = await getValues(SPREADSHEET_ID, sheet);
      optChecks.push({ name, rows: rows ? rows.length - 1 : 0, ok: rows && rows.length > 1 });
    } catch (e) {
      optChecks.push({ name, rows: 0, ok: false, error: e.message });
    }
  }

  // Check performance modifiers from Supabase
  if (db.isEnabled()) {
    try {
      const mods = await db.readModifiers();
      const entries = Object.entries(mods);
      const suppressed = entries.filter(([, v]) => v < 0.5).length;
      const boosted = entries.filter(([, v]) => v > 1.0).length;
      optChecks.push({
        name: 'Performance Modifiers',
        rows: entries.length,
        ok: entries.length > 0,
        extra: `${boosted} boosted, ${suppressed} suppressed`,
      });
    } catch (e) {
      optChecks.push({ name: 'Performance Modifiers', rows: 0, ok: false });
    }
  }

  checks.push({
    section: 'Optimization Data',
    status: optChecks.every(o => o.ok) ? 'ok' : 'warn',
    detail: optChecks.map(o => `${o.name}: ${o.rows} rows${o.extra ? ' (' + o.extra + ')' : ''}`).join(' · '),
    items: optChecks,
  });

  return checks;
}

// ── Part 2: Performance Report ──────────────────────────────────

async function runPerformanceReport() {
  // Read Performance Log + Prop Performance in parallel
  const [perfRows, propRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE),
    getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE),
  ]);

  // ── 2a. Game Picks Performance ──

  // Performance Log columns (0-indexed):
  //   0: date, 1: league, 2: market, 3: away, 4: home, 5: start_time,
  //   6: bet_type, 7: pick, 8: line, 9: odds, 10: units, 11: confidence,
  //   12-15: various, 16: result (W/L/P), 17: units_returned,
  //   18-19: various, 20: actual_result, 21: approval_status, 22: approval_reason

  const gameData = {};  // { windowDays: { 'league|betType|purpose': stats } }
  for (const w of WINDOWS) {
    gameData[w] = {};
  }

  if (perfRows && perfRows.length > 1) {
    for (let i = 1; i < perfRows.length; i++) {
      const row = perfRows[i];
      if (!row || row.length < 18) continue;

      const result = (row[16] || '').toString().trim();
      if (result !== 'W' && result !== 'L' && result !== 'P') continue;

      const d = parseSheetDate(row[0]);
      if (!d) continue;

      const league = (row[1] || '').trim() || 'Unknown';
      const betType = (row[6] || '').trim() || 'Unknown';
      const units = parseFloat(row[10]) || 0;
      const unitReturn = parseFloat(row[17]) || 0;
      const approval = (row[21] || '').toString().trim();
      const purpose = approval === 'approved' ? 'approved' : 'tracking';

      for (const w of WINDOWS) {
        if (d < daysAgo(w)) continue;

        // By league
        const lKey = `${league}|ALL|all`;
        if (!gameData[w][lKey]) gameData[w][lKey] = { w: 0, l: 0, p: 0, wagered: 0, returned: 0 };
        if (result === 'W') gameData[w][lKey].w++;
        else if (result === 'L') gameData[w][lKey].l++;
        else gameData[w][lKey].p++;
        gameData[w][lKey].wagered += units;
        gameData[w][lKey].returned += unitReturn;

        // By league + bet type
        const btKey = `${league}|${betType}|all`;
        if (!gameData[w][btKey]) gameData[w][btKey] = { w: 0, l: 0, p: 0, wagered: 0, returned: 0 };
        if (result === 'W') gameData[w][btKey].w++;
        else if (result === 'L') gameData[w][btKey].l++;
        else gameData[w][btKey].p++;
        gameData[w][btKey].wagered += units;
        gameData[w][btKey].returned += unitReturn;

        // By purpose (approved vs tracking)
        const pKey = `ALL|ALL|${purpose}`;
        if (!gameData[w][pKey]) gameData[w][pKey] = { w: 0, l: 0, p: 0, wagered: 0, returned: 0 };
        if (result === 'W') gameData[w][pKey].w++;
        else if (result === 'L') gameData[w][pKey].l++;
        else gameData[w][pKey].p++;
        gameData[w][pKey].wagered += units;
        gameData[w][pKey].returned += unitReturn;

        // Grand total
        const tKey = 'ALL|ALL|all';
        if (!gameData[w][tKey]) gameData[w][tKey] = { w: 0, l: 0, p: 0, wagered: 0, returned: 0 };
        if (result === 'W') gameData[w][tKey].w++;
        else if (result === 'L') gameData[w][tKey].l++;
        else gameData[w][tKey].p++;
        gameData[w][tKey].wagered += units;
        gameData[w][tKey].returned += unitReturn;

        // By league + purpose
        const lpKey = `${league}|ALL|${purpose}`;
        if (!gameData[w][lpKey]) gameData[w][lpKey] = { w: 0, l: 0, p: 0, wagered: 0, returned: 0 };
        if (result === 'W') gameData[w][lpKey].w++;
        else if (result === 'L') gameData[w][lpKey].l++;
        else gameData[w][lpKey].p++;
        gameData[w][lpKey].wagered += units;
        gameData[w][lpKey].returned += unitReturn;
      }
    }
  }

  // ── 2b. Prop Performance ──

  // Prop_Performance columns (from props.js gradePropPicks):
  //   0: Timestamp, 1: League, 2: Player, 3: Market, 4: Line, 5: Direction,
  //   6: Book, 7: Edge, 8: Actual, 9: Result (W/L/PUSH/UNMATCHED),
  //   10: AdjustedEdge, 11: Confidence, 12: Units

  const propData = {};
  for (const w of WINDOWS) {
    propData[w] = {};
  }

  if (propRows && propRows.length > 1) {
    for (let i = 1; i < propRows.length; i++) {
      const row = propRows[i];
      if (!row || row.length < 10) continue;

      const result = (row[9] || '').toString().trim().toUpperCase();
      if (result !== 'W' && result !== 'L') continue;

      const d = parseSheetDate(row[0]) || new Date(row[0]);
      if (!d || isNaN(d.getTime())) continue;

      const league = (row[1] || '').trim() || 'Unknown';
      const market = (row[3] || '').trim() || 'Unknown';
      const edge = parseFloat(row[7]) || 0;

      for (const w of WINDOWS) {
        if (d < daysAgo(w)) continue;

        // By league
        const lKey = `${league}|ALL`;
        if (!propData[w][lKey]) propData[w][lKey] = { w: 0, l: 0, totalEdge: 0 };
        if (result === 'W') propData[w][lKey].w++;
        else propData[w][lKey].l++;
        propData[w][lKey].totalEdge += edge;

        // By league + market
        const mKey = `${league}|${market}`;
        if (!propData[w][mKey]) propData[w][mKey] = { w: 0, l: 0, totalEdge: 0 };
        if (result === 'W') propData[w][mKey].w++;
        else propData[w][mKey].l++;
        propData[w][mKey].totalEdge += edge;

        // Grand total
        const tKey = 'ALL|ALL';
        if (!propData[w][tKey]) propData[w][tKey] = { w: 0, l: 0, totalEdge: 0 };
        if (result === 'W') propData[w][tKey].w++;
        else propData[w][tKey].l++;
        propData[w][tKey].totalEdge += edge;
      }
    }
  }

  // ── 2c. Calibration data ──
  let calibrationData = null;
  if (db.isEnabled()) {
    try {
      calibrationData = await db.getConfidenceCalibration();
    } catch (e) {
      console.warn('[check] Calibration read failed:', e.message);
    }
  }

  // ── 2d. Performance modifiers ──
  let modifiers = null;
  if (db.isEnabled()) {
    try {
      modifiers = await db.readModifiers();
    } catch (e) {
      console.warn('[check] Modifiers read failed:', e.message);
    }
  }

  return { gameData, propData, calibrationData, modifiers };
}

// ── HTML Rendering ──────────────────────────────────────────────

function renderHealthCheckHTML(checks) {
  const statusIcon = { ok: '&#9989;', warn: '&#9888;&#65039;', error: '&#10060;' };
  const statusColor = { ok: '#d8f3dc', warn: '#fff3cd', error: '#ffd6d6' };

  let html = '';

  for (const check of checks) {
    html += `
    <div style="background:${statusColor[check.status]};border-radius:8px;padding:12px 16px;margin-bottom:12px;">
      <strong>${statusIcon[check.status]} ${check.section}</strong>
      <div style="margin-top:4px;font-size:13px;color:#333;">${check.detail}</div>
    </div>`;

    // Trigger details
    if (check.failed && check.failed.length > 0) {
      html += '<table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px;">';
      html += '<tr style="background:#d00000;color:white;"><th style="padding:4px 6px;">Trigger</th><th style="padding:4px 6px;">Error</th></tr>';
      for (const f of check.failed) {
        html += `<tr style="background:#fff0f0;"><td style="padding:4px 6px;border:1px solid #eee;">${f.name}</td><td style="padding:4px 6px;border:1px solid #eee;font-size:11px;">${(f.error || '').substring(0, 100)}</td></tr>`;
      }
      html += '</table>';
    }
    if (check.missing && check.missing.length > 0) {
      html += `<div style="font-size:13px;color:#e85d04;margin-bottom:8px;"><strong>Missing:</strong> ${check.missing.join(', ')}</div>`;
    }

    // Data freshness details
    if (check.items && check.section === 'Data Freshness') {
      html += '<table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px;">';
      html += '<tr style="background:#333;color:white;"><th style="padding:4px 6px;">Sheet</th><th style="padding:4px 6px;">Rows</th><th style="padding:4px 6px;">Latest Data</th><th style="padding:4px 6px;">Status</th></tr>';
      for (const item of check.items) {
        const statusTxt = item.stale ? '<span style="color:#e74c3c;">STALE</span>' : '<span style="color:#27ae60;">Fresh</span>';
        const dateStr = item.latest ? item.latest.toLocaleDateString('en-US') : '—';
        html += `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${item.name}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${item.rows.toLocaleString()}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${dateStr}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${statusTxt}</td></tr>`;
      }
      html += '</table>';
    }
  }

  return html;
}

function renderGamePerformanceHTML(gameData) {
  const leagues = ['MLB', 'NBA', 'NHL', 'NFL'];
  const betTypes = ['moneyline', 'spread', 'total'];

  let html = '';

  // ── Summary cards (one per window) ──
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">';
  for (const w of WINDOWS) {
    const total = gameData[w]['ALL|ALL|all'];
    if (!total) {
      html += `<div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:8px;padding:12px;text-align:center;"><div style="font-size:12px;color:#666;">${w}-Day</div><div style="font-size:14px;color:#999;">No data</div></div>`;
      continue;
    }
    const roi = total.wagered > 0 ? (total.returned / total.wagered * 100) : 0;
    html += `
    <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:12px;color:#666;">${w}-Day</div>
      <div style="font-size:18px;font-weight:bold;">${total.w}-${total.l}-${total.p}</div>
      <div style="font-size:14px;color:${colorVal(total.returned)};">${signedNum(total.returned)}u</div>
      <div style="font-size:12px;color:${colorVal(roi)};">${roi.toFixed(1)}% ROI</div>
    </div>`;
  }
  html += '</div>';

  // ── By League table ──
  html += '<h3 style="color:#16213e;margin-bottom:6px;">By League</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">';
  html += '<tr style="background:#0f3460;color:white;"><th style="padding:5px 6px;">League</th>';
  for (const w of WINDOWS) html += `<th style="padding:5px 6px;" colspan="3">${w}d</th>`;
  html += '</tr>';
  html += '<tr style="background:#e8eaf6;font-size:11px;"><td></td>';
  for (const w of WINDOWS) html += '<td style="padding:2px 6px;">Record</td><td style="padding:2px 6px;">Units</td><td style="padding:2px 6px;">ROI</td>';
  html += '</tr>';

  for (const league of leagues) {
    html += `<tr><td style="padding:5px 6px;border-bottom:1px solid #eee;font-weight:bold;">${league}</td>`;
    for (const w of WINDOWS) {
      const s = gameData[w][`${league}|ALL|all`];
      if (!s) {
        html += '<td style="padding:5px 6px;border-bottom:1px solid #eee;color:#ccc;" colspan="3">—</td>';
        continue;
      }
      const roi = s.wagered > 0 ? (s.returned / s.wagered * 100) : 0;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;">${s.w}-${s.l}-${s.p}</td>`;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;color:${colorVal(s.returned)};">${signedNum(s.returned)}</td>`;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;color:${colorVal(roi)};">${roi.toFixed(1)}%</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';

  // ── By Bet Type within League ──
  html += '<h3 style="color:#16213e;margin-bottom:6px;">By League + Bet Type</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">';
  html += '<tr style="background:#0f3460;color:white;"><th style="padding:4px 6px;">League</th><th style="padding:4px 6px;">Type</th>';
  for (const w of WINDOWS) html += `<th style="padding:4px 6px;">${w}d Record</th><th style="padding:4px 6px;">${w}d Units</th>`;
  html += '</tr>';

  for (const league of leagues) {
    for (const bt of betTypes) {
      html += `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${league}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${bt}</td>`;
      for (const w of WINDOWS) {
        const s = gameData[w][`${league}|${bt}|all`];
        if (!s) {
          html += '<td style="padding:4px 6px;border-bottom:1px solid #eee;color:#ccc;">—</td><td style="padding:4px 6px;border-bottom:1px solid #eee;color:#ccc;">—</td>';
          continue;
        }
        html += `<td style="padding:4px 6px;border-bottom:1px solid #eee;">${s.w}-${s.l}-${s.p} (${pct(s.w, s.w + s.l)})</td>`;
        html += `<td style="padding:4px 6px;border-bottom:1px solid #eee;color:${colorVal(s.returned)};">${signedNum(s.returned)}</td>`;
      }
      html += '</tr>';
    }
  }
  html += '</table>';

  // ── Approved vs Tracking ──
  html += '<h3 style="color:#16213e;margin-bottom:6px;">Approved vs Tracking</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">';
  html += '<tr style="background:#0f3460;color:white;"><th style="padding:5px 6px;">Purpose</th>';
  for (const w of WINDOWS) html += `<th style="padding:5px 6px;">${w}d Record</th><th style="padding:5px 6px;">${w}d Units</th><th style="padding:5px 6px;">${w}d ROI</th>`;
  html += '</tr>';

  for (const purpose of ['approved', 'tracking']) {
    const label = purpose === 'approved' ? '&#9989; Approved' : '&#128065; Tracking';
    html += `<tr><td style="padding:5px 6px;border-bottom:1px solid #eee;">${label}</td>`;
    for (const w of WINDOWS) {
      const s = gameData[w][`ALL|ALL|${purpose}`];
      if (!s) {
        html += '<td style="padding:5px 6px;border-bottom:1px solid #eee;color:#ccc;" colspan="3">—</td>';
        continue;
      }
      const roi = s.wagered > 0 ? (s.returned / s.wagered * 100) : 0;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;">${s.w}-${s.l}-${s.p} (${pct(s.w, s.w + s.l)})</td>`;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;color:${colorVal(s.returned)};">${signedNum(s.returned)}</td>`;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;color:${colorVal(roi)};">${roi.toFixed(1)}%</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';

  return html;
}

function renderPropPerformanceHTML(propData) {
  let html = '';

  // Summary cards
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">';
  for (const w of WINDOWS) {
    const total = propData[w]['ALL|ALL'];
    if (!total) {
      html += `<div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:8px;padding:12px;text-align:center;"><div style="font-size:12px;color:#666;">${w}-Day</div><div style="font-size:14px;color:#999;">No data</div></div>`;
      continue;
    }
    const hitRate = total.w + total.l > 0 ? (total.w / (total.w + total.l) * 100) : 0;
    const avgEdge = total.w + total.l > 0 ? (total.totalEdge / (total.w + total.l)) : 0;
    html += `
    <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:12px;color:#666;">${w}-Day Props</div>
      <div style="font-size:18px;font-weight:bold;">${total.w}-${total.l}</div>
      <div style="font-size:14px;color:${hitRate >= 52 ? '#27ae60' : '#e74c3c'};">${hitRate.toFixed(1)}% hit</div>
      <div style="font-size:12px;color:#666;">${avgEdge.toFixed(1)}% avg edge</div>
    </div>`;
  }
  html += '</div>';

  // By league
  const leagues = ['MLB', 'NBA', 'NHL', 'NFL'];
  html += '<h3 style="color:#16213e;margin-bottom:6px;">Props by League</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">';
  html += '<tr style="background:#0f3460;color:white;"><th style="padding:5px 6px;">League</th>';
  for (const w of WINDOWS) html += `<th style="padding:5px 6px;">${w}d Record</th><th style="padding:5px 6px;">${w}d Hit%</th>`;
  html += '</tr>';

  for (const league of leagues) {
    html += `<tr><td style="padding:5px 6px;border-bottom:1px solid #eee;font-weight:bold;">${league}</td>`;
    for (const w of WINDOWS) {
      const s = propData[w][`${league}|ALL`];
      if (!s) {
        html += '<td style="padding:5px 6px;border-bottom:1px solid #eee;color:#ccc;" colspan="2">—</td>';
        continue;
      }
      const hitRate = s.w + s.l > 0 ? (s.w / (s.w + s.l) * 100) : 0;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;">${s.w}-${s.l}</td>`;
      html += `<td style="padding:5px 6px;border-bottom:1px solid #eee;color:${hitRate >= 52 ? '#27ae60' : '#e74c3c'};">${hitRate.toFixed(1)}%</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';

  // Top/bottom prop markets (30-day, if enough data)
  const market30 = propData[30] || {};
  const marketEntries = Object.entries(market30)
    .filter(([k]) => !k.includes('ALL') && k.split('|')[1] !== 'ALL')
    .map(([k, s]) => {
      const [league, market] = k.split('|');
      const total = s.w + s.l;
      const hitRate = total > 0 ? (s.w / total * 100) : 0;
      return { league, market, ...s, total, hitRate };
    })
    .filter(m => m.total >= 5)
    .sort((a, b) => b.hitRate - a.hitRate);

  if (marketEntries.length > 0) {
    html += '<h3 style="color:#16213e;margin-bottom:6px;">Prop Markets (30-day, min 5 picks)</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">';
    html += '<tr style="background:#0f3460;color:white;"><th style="padding:4px 6px;">League</th><th style="padding:4px 6px;">Market</th><th style="padding:4px 6px;">Record</th><th style="padding:4px 6px;">Hit Rate</th><th style="padding:4px 6px;">Avg Edge</th></tr>';
    for (const m of marketEntries) {
      const avgEdge = m.total > 0 ? (m.totalEdge / m.total) : 0;
      html += `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${m.league}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${m.market}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${m.w}-${m.l}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;color:${m.hitRate >= 52 ? '#27ae60' : '#e74c3c'};font-weight:bold;">${m.hitRate.toFixed(1)}%</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${avgEdge.toFixed(1)}%</td></tr>`;
    }
    html += '</table>';
  }

  return html;
}

function renderModifiersHTML(modifiers) {
  if (!modifiers || Object.keys(modifiers).length === 0) return '';

  const entries = Object.entries(modifiers)
    .map(([key, val]) => {
      const [league, market] = key.split('|');
      return { league, market, modifier: val };
    })
    .sort((a, b) => b.modifier - a.modifier);

  let html = '<h3 style="color:#16213e;margin-bottom:6px;">Active Performance Modifiers</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">';
  html += '<tr style="background:#0f3460;color:white;"><th style="padding:4px 6px;">League</th><th style="padding:4px 6px;">Market</th><th style="padding:4px 6px;">Modifier</th><th style="padding:4px 6px;">Effect</th></tr>';
  for (const e of entries) {
    const effect = e.modifier > 1.0 ? 'Boosted' : e.modifier < 0.5 ? 'Suppressed' : e.modifier < 1.0 ? 'Reduced' : 'Neutral';
    const effColor = e.modifier > 1.0 ? '#27ae60' : e.modifier < 0.5 ? '#e74c3c' : e.modifier < 1.0 ? '#e67e22' : '#666';
    html += `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${e.league}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${e.market}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;font-weight:bold;">${e.modifier.toFixed(2)}x</td><td style="padding:4px 6px;border-bottom:1px solid #eee;color:${effColor};">${effect}</td></tr>`;
  }
  html += '</table>';
  return html;
}

function renderCalibrationHTML(calibrationData) {
  if (!calibrationData || calibrationData.length === 0) return '';

  let html = '<h3 style="color:#16213e;margin-bottom:6px;">Calibration (Expected vs Actual Win Rate)</h3>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">';
  html += '<tr style="background:#0f3460;color:white;"><th style="padding:4px 6px;">Edge Bucket</th><th style="padding:4px 6px;">Expected</th><th style="padding:4px 6px;">Actual</th><th style="padding:4px 6px;">Multiplier</th><th style="padding:4px 6px;">Samples</th></tr>';
  for (const row of calibrationData) {
    const diff = (row.actual_win_rate || 0) - (row.expected_win_rate || 0);
    const diffColor = diff >= 0 ? '#27ae60' : '#e74c3c';
    html += `<tr><td style="padding:4px 6px;border-bottom:1px solid #eee;">${row.edge_bucket || row.bucket || '—'}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${pct(row.expected_win_rate, 1).replace('%','')}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;color:${diffColor};font-weight:bold;">${pct(row.actual_win_rate, 1).replace('%','')}</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${(row.multiplier || 1).toFixed(2)}x</td><td style="padding:4px 6px;border-bottom:1px solid #eee;">${row.sample_size || row.samples || '—'}</td></tr>`;
  }
  html += '</table>';
  return html;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('[system-check] Starting full system check...');

  const [healthChecks, perfReport] = await Promise.all([
    runHealthCheck(),
    runPerformanceReport(),
  ]);

  const { gameData, propData, calibrationData, modifiers } = perfReport;

  const overallHealth = healthChecks.every(c => c.status === 'ok');
  const headerEmoji = overallHealth ? '&#9989;' : '&#9888;&#65039;';
  const headerColor = overallHealth ? '#2d6a4f' : '#e85d04';
  const nowFmt = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });

  const html = `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: 'Segoe UI', Roboto, Arial, sans-serif; max-width: 750px; margin: 0 auto; padding: 16px; color: #1a1a2e; }
  h1 { margin-bottom: 4px; }
  h2 { color: #0f3460; border-bottom: 2px solid #0f3460; padding-bottom: 5px; margin-top: 30px; }
  h3 { margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  .section { margin-bottom: 24px; }
</style></head>
<body>
  <h1 style="color:${headerColor};">${headerEmoji} Shadow Bets System Check</h1>
  <p style="color:#666;margin-top:0;">${nowFmt} ET</p>

  <h2>&#128269; System Health</h2>
  ${renderHealthCheckHTML(healthChecks)}

  <h2>&#127919; Game Pick Performance</h2>
  ${renderGamePerformanceHTML(gameData)}

  <h2>&#127922; Prop Performance</h2>
  ${renderPropPerformanceHTML(propData)}

  ${renderModifiersHTML(modifiers)}

  ${renderCalibrationHTML(calibrationData)}

  <hr style="margin-top:24px;border:none;border-top:1px solid #eee;">
  <p style="font-size:11px;color:#999;">Shadow Bets System Check — manual dispatch</p>
</body>
</html>
`;

  // Send email
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const total30 = gameData[30] && gameData[30]['ALL|ALL|all'];
  const subjectStats = total30
    ? `${total30.w}-${total30.l}-${total30.p} | ${signedNum(total30.returned)}u`
    : 'No data';

  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: `${overallHealth ? '✅' : '⚠️'} Shadow Bets System Check — 30d: ${subjectStats}`,
    html,
  });

  console.log(`[system-check] Email sent to ${EMAIL_RECIPIENTS.length} recipients`);
  console.log('[system-check] Done.');
}

main().catch(err => {
  console.error('[system-check] FATAL:', err);
  process.exit(1);
});
