'use strict';
// =============================================================
// src/emails.js — Email formatting via Gmail API (nodemailer)
// Replaces: MailApp.sendEmail() in Apps Script
//
// ── Sprint 3: Approval-aware email ──
// Daily email now reads Performance_Log (not sport-specific sheets)
// and splits into two sections:
//   1. Recommended Plays — approved picks only (high-conviction)
//   2. Full Tracking Card — all picks for the day
// =============================================================

const nodemailer = require('nodemailer');
const { SPREADSHEET_ID, SHEETS, GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENTS } = require('./config');
const { getValues, appendRows } = require('./sheets');
let _emailDb = null;
function getEmailDb() { if (!_emailDb) _emailDb = require('./db'); return _emailDb; }

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
  return _transporter;
}

/**
 * Send the daily picks email.
 * Trigger 9: ~6:30 AM ET daily
 *
 * Sprint 3: Reads today's picks from Performance_Log instead of
 * sport-specific prediction sheets. Splits by approval_status.
 */
async function sendDailyPicksEmail() {
  console.log('[emails] Sending daily picks email...');

  // Read Performance Log + player props in parallel
  const [perfRows, propCombos, propsRaw] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE),
    getValues(SPREADSHEET_ID, SHEETS.PLATFORM_COMBOS),
    getValues(SPREADSHEET_ID, SHEETS.PLAYER_PROPS),
  ]);

  // Filter to today's picks from Performance_Log
  // Performance_Log columns (0-indexed):
  //   0: date, 1: league, 2: market, 3: away, 4: home, 5: start_time,
  //   6: bet_type, 7: pick, 8: line, 9: odds, 10: units, 11: confidence,
  //   19: Notes, 20: actual_result, 21: approval_status, 22: approval_reason
  const today = new Date();
  const mm = String(today.getMonth() + 1);
  const dd = String(today.getDate());
  const yyyy = today.getFullYear();
  const todayStr = `${mm}/${dd}/${yyyy}`;

  const todayPicks = (perfRows || []).slice(1).filter(row => {
    const rowDate = String(row[0] || '').trim();
    // Match MM/DD/YYYY format — handle single-digit month/day
    const rowParts = rowDate.split('/');
    if (rowParts.length !== 3) return false;
    const normalized = `${parseInt(rowParts[0])}/${parseInt(rowParts[1])}/${rowParts[2]}`;
    return normalized === todayStr;
  });

  const approved = todayPicks.filter(r => (r[21] || '').toString().trim() === 'approved');
  const allPicks = todayPicks;

  console.log(`[emails] Today's picks: ${allPicks.length} total, ${approved.length} approved`);

  // ── Format approved picks (Recommended Plays) ──
  const formatApprovedSection = () => {
    if (approved.length === 0) {
      return '<p><em>No recommended plays today — all picks are tracking-only.</em></p>';
    }
    // Group by league
    const byLeague = {};
    for (const r of approved) {
      const league = r[1] || 'Other';
      if (!byLeague[league]) byLeague[league] = [];
      byLeague[league].push(r);
    }
    let html = '';
    for (const [league, picks] of Object.entries(byLeague)) {
      const leagueEmoji = { MLB: '&#9918;', NBA: '&#127936;', NHL: '&#127954;', NFL: '&#127944;' }[league] || '';
      html += `<h3 style="color:#16213e;margin-bottom:5px;">${leagueEmoji} ${league}</h3>`;
      html += '<table style="width:100%;border-collapse:collapse;margin-bottom:15px;">';
      html += '<tr style="background:#0f3460;color:white;"><th style="padding:6px;">Pick</th><th style="padding:6px;">Market</th><th style="padding:6px;">Line</th><th style="padding:6px;">Odds</th><th style="padding:6px;">Units</th><th style="padding:6px;">Conf</th></tr>';
      for (const r of picks) {
        const conf = String(r[11] || '').replace('%', '');
        const confNum = parseInt(conf) || 0;
        const confStyle = confNum >= 7 ? 'color:#27ae60;font-weight:bold;' : '';
        html += `<tr>`;
        html += `<td style="padding:6px;border-bottom:1px solid #eee;"><strong>${r[7] || ''}</strong></td>`;
        html += `<td style="padding:6px;border-bottom:1px solid #eee;">${r[6] || ''}</td>`;
        html += `<td style="padding:6px;border-bottom:1px solid #eee;">${r[8] || ''}</td>`;
        html += `<td style="padding:6px;border-bottom:1px solid #eee;">${r[9] || ''}</td>`;
        html += `<td style="padding:6px;border-bottom:1px solid #eee;">${r[10] || ''}</td>`;
        html += `<td style="padding:6px;border-bottom:1px solid #eee;${confStyle}">${r[11] || ''}</td>`;
        html += `</tr>`;
      }
      html += '</table>';
    }
    return html;
  };

  // ── Format all picks (Full Tracking Card) ──
  const formatTrackingSection = () => {
    if (allPicks.length === 0) {
      return '<p><em>No picks generated today.</em></p>';
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<tr style="background:#333;color:white;"><th style="padding:4px;">League</th><th style="padding:4px;">Pick</th><th style="padding:4px;">Market</th><th style="padding:4px;">Line</th><th style="padding:4px;">Odds</th><th style="padding:4px;">Units</th><th style="padding:4px;">Status</th></tr>';
    for (const r of allPicks) {
      const status = (r[21] || 'tracking_only').toString().trim();
      const statusLabel = status === 'approved' ? '&#9989;' : '&#128065;';
      const rowBg = status === 'approved' ? 'background:#f0fdf4;' : '';
      html += `<tr style="${rowBg}">`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;">${r[1] || ''}</td>`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;">${r[7] || ''}</td>`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;">${r[6] || ''}</td>`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;">${r[8] || ''}</td>`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;">${r[9] || ''}</td>`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;">${r[10] || ''}</td>`;
      html += `<td style="padding:4px;border-bottom:1px solid #eee;text-align:center;">${statusLabel}</td>`;
      html += `</tr>`;
    }
    html += '</table>';
    return html;
  };

  // ── Player Props section (unchanged from pre-Sprint 3) ──
  const formatPropRows = () => {
    if (propCombos && propCombos.length > 1) {
      return propCombos.slice(1, 16).map(r => {
        const edgeNum = parseFloat(r[10]);
        const edgeLabel = Number.isFinite(edgeNum) ? `${edgeNum.toFixed(1)}%` : (r[10] || '');
        const elite = Number.isFinite(edgeNum) && edgeNum >= 2 ? ' &#11088;' : '';
        return `<tr><td style="padding:6px;">${r[2] || ''}</td><td style="padding:6px;">${r[3] || ''} ${r[5] || ''} ${r[4] || ''}</td><td style="padding:6px;">${r[6] || ''} @ ${r[7] || ''}</td><td style="padding:6px;">${edgeLabel}${elite}</td></tr>`;
      }).join('');
    }
    if (propsRaw && propsRaw.length > 1) {
      return propsRaw.slice(1, 16).map(r =>
        `<tr><td style="padding:6px;">${r[3] || ''}</td><td style="padding:6px;">${r[7] || ''} ${r[4] || ''} ${r[6] || ''}</td><td style="padding:6px;">${r[2] || ''} @ ${r[5] || ''}</td><td style="padding:6px;">—</td></tr>`
      ).join('');
    }
    return '<tr><td colspan="4" style="padding:6px;"><em>No props today.</em></td></tr>';
  };

  const todayFmt = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const html = `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; }
  h1 { color: #1a1a2e; }
  h2 { color: #16213e; border-bottom: 2px solid #0f3460; padding-bottom: 5px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; }
  tr:hover { background: #f5f5f5; }
  .footer { color: #666; font-size: 12px; margin-top: 30px; }
  .summary { background: #f8f9fa; padding: 12px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
</style></head>
<body>
  <h1>&#127919; Shadow Bets Daily Picks</h1>
  <p>${todayFmt}</p>

  <div class="summary">
    <strong>${approved.length}</strong> recommended plays &middot; <strong>${allPicks.length}</strong> total picks tracked
  </div>

  <h2>&#128640; Recommended Plays</h2>
  <p style="font-size:12px;color:#666;margin-top:-5px;">High-conviction picks that passed all approval filters</p>
  ${formatApprovedSection()}

  <h2>&#127922; Player Props — Top Picks</h2>
  <p style="font-size:12px;color:#666;margin-top:-5px;">&#11088; = elite edge (&#8805;2% over consensus)</p>
  <table>
    <tr style="background:#0f3460;color:white;"><th style="padding:6px;">Player</th><th style="padding:6px;">Pick</th><th style="padding:6px;">Book / Odds</th><th style="padding:6px;">Edge</th></tr>
    ${formatPropRows()}
  </table>

  <h2>&#128202; Full Tracking Card</h2>
  <p style="font-size:12px;color:#666;margin-top:-5px;">All picks for tracking &middot; &#9989; = approved &middot; &#128065; = tracking only</p>
  ${formatTrackingSection()}

  <div class="footer">
    <p>Generated by Shadow Bets automation. For informational purposes only.</p>
    <p style="font-size:11px;">Approval filters: edge, market quality, data completeness, confidence, uncertainty</p>
  </div>
</body>
</html>
`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: `🎯 Shadow Bets — ${approved.length} Recommended Plays — ${todayFmt}`,
    html,
  });

  // Log to EmailLog sheet
  const ts = new Date().toISOString();
  await appendRows(SPREADSHEET_ID, SHEETS.EMAIL_LOG, [
    [ts, 'DailyPicks', EMAIL_RECIPIENTS.join(','), 'sent', `${approved.length} approved, ${allPicks.length} total`],
  ]);

  console.log(`[emails] Daily picks email sent to ${EMAIL_RECIPIENTS.length} recipients (${approved.length} approved, ${allPicks.length} total)`);
}

/**
 * Send a performance summary email.
 * Trigger 13: Sunday evening
 */
async function sendPerformanceSummary() {
  console.log('[emails] Sending performance summary...');

  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) {
    console.log('[emails] No performance data for summary');
    return;
  }

  // Find graded picks from the last 7 days
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Aggregate by league
  const leagueStats = {};
  let totalW = 0, totalL = 0, totalP = 0, totalUnitsWagered = 0, totalUnitsReturned = 0;

  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 18) continue;

    const result = (row[16] || '').toString().trim();
    if (result !== 'W' && result !== 'L' && result !== 'P') continue;

    // Parse date (MM/DD/YYYY)
    const rawDate = String(row[0] || '').trim();
    const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!parts) continue;
    const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (pickDate < sevenDaysAgo) continue;

    const league = (row[1] || '').trim() || 'Unknown';
    const units = parseFloat(row[10]) || 0;
    const unitReturn = parseFloat(row[17]) || 0;

    if (!leagueStats[league]) {
      leagueStats[league] = { w: 0, l: 0, p: 0, wagered: 0, returned: 0 };
    }

    if (result === 'W') { leagueStats[league].w++; totalW++; }
    else if (result === 'L') { leagueStats[league].l++; totalL++; }
    else { leagueStats[league].p++; totalP++; }

    leagueStats[league].wagered += units;
    leagueStats[league].returned += unitReturn;
    totalUnitsWagered += units;
    totalUnitsReturned += unitReturn;
  }

  const totalPicks = totalW + totalL + totalP;
  if (totalPicks === 0) {
    console.log('[emails] No graded picks in last 7 days — skipping summary');
    return;
  }

  const totalROI = totalUnitsWagered > 0
    ? ((totalUnitsReturned / totalUnitsWagered) * 100).toFixed(1)
    : '0.0';
  const winPct = ((totalW / (totalW + totalL)) * 100).toFixed(1);

  // Build league breakdown rows
  const leagueRows = Object.entries(leagueStats)
    .sort((a, b) => b[1].returned - a[1].returned)
    .map(([league, s]) => {
      const roi = s.wagered > 0 ? ((s.returned / s.wagered) * 100).toFixed(1) : '0.0';
      const color = s.returned >= 0 ? '#27ae60' : '#e74c3c';
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${league}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${s.w}-${s.l}-${s.p}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${s.wagered.toFixed(2)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:${color};font-weight:bold;">${s.returned >= 0 ? '+' : ''}${s.returned.toFixed(2)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:${color};">${roi}%</td>
      </tr>`;
    }).join('');

  const netColor = totalUnitsReturned >= 0 ? '#27ae60' : '#e74c3c';
  const netSign = totalUnitsReturned >= 0 ? '+' : '';

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #0f3460;">&#128202; Shadow Bets Weekly Performance</h1>
  <p style="color: #666; margin-bottom: 20px;">Last 7 days &mdash; ${totalPicks} graded picks</p>

  <div style="background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
    <table style="width:100%;">
      <tr>
        <td style="text-align:center;">
          <div style="font-size:24px;font-weight:bold;">${totalW}-${totalL}-${totalP}</div>
          <div style="color:#666;font-size:12px;">Record</div>
        </td>
        <td style="text-align:center;">
          <div style="font-size:24px;font-weight:bold;">${winPct}%</div>
          <div style="color:#666;font-size:12px;">Win Rate</div>
        </td>
        <td style="text-align:center;">
          <div style="font-size:24px;font-weight:bold;color:${netColor};">${netSign}${totalUnitsReturned.toFixed(2)}u</div>
          <div style="color:#666;font-size:12px;">Net Units</div>
        </td>
        <td style="text-align:center;">
          <div style="font-size:24px;font-weight:bold;color:${netColor};">${totalROI}%</div>
          <div style="color:#666;font-size:12px;">ROI</div>
        </td>
      </tr>
    </table>
  </div>

  <h2 style="color: #0f3460; font-size: 16px;">By League</h2>
  <table style="width:100%;border-collapse:collapse;">
    <tr style="background:#0f3460;color:white;">
      <th style="padding:8px;text-align:left;">League</th>
      <th style="padding:8px;text-align:left;">Record</th>
      <th style="padding:8px;text-align:left;">Wagered</th>
      <th style="padding:8px;text-align:left;">Net Units</th>
      <th style="padding:8px;text-align:left;">ROI</th>
    </tr>
    ${leagueRows}
    <tr style="background:#f0f0f0;font-weight:bold;">
      <td style="padding:8px;">Total</td>
      <td style="padding:8px;">${totalW}-${totalL}-${totalP}</td>
      <td style="padding:8px;">${totalUnitsWagered.toFixed(2)}</td>
      <td style="padding:8px;color:${netColor};">${netSign}${totalUnitsReturned.toFixed(2)}</td>
      <td style="padding:8px;color:${netColor};">${totalROI}%</td>
    </tr>
  </table>

  <p style="color: #999; font-size: 11px; margin-top: 20px;">
    Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
  </p>
</body>
</html>
`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: `📊 Shadow Bets Weekly: ${totalW}-${totalL}-${totalP} | ${netSign}${totalUnitsReturned.toFixed(2)}u (${totalROI}% ROI)`,
    html,
  });

  const ts = new Date().toISOString();
  await appendRows(SPREADSHEET_ID, SHEETS.EMAIL_LOG, [
    [ts, 'PerformanceSummary', EMAIL_RECIPIENTS.join(','), 'sent', `${totalW}-${totalL}-${totalP} ${netSign}${totalUnitsReturned.toFixed(2)}u`],
  ]);

  console.log(`[emails] Performance summary sent: ${totalW}-${totalL}-${totalP}, ${netSign}${totalUnitsReturned.toFixed(2)}u`);
}
module.exports = { sendDailyPicksEmail, sendPerformanceSummary, sendTriggerHealthCheck };

// ── Trigger Health Check ─────────────────────────────────────────

/**
 * Daily health check: compare today's Trigger_Monitor entries against
 * the expected schedule. Alert via email if any triggers are missing or failed.
 *
 * Trigger 16: runs at midnight ET (after all daily triggers complete).
 *
 * Expected daily triggers (weekdays):
 *   trigger1-4, trigger6-12, trigger14
 * Sunday only: trigger13
 * Manual only: trigger5 (no-op), trigger15 (bootstrap), trigger16 (this)
 */
async function sendTriggerHealthCheck() {
  console.log('[emails] Running daily trigger health check...');

  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Build runMap from Sheets first, then Supabase as fallback.
  // When the workbook hits 10M cells, Trigger_Monitor writes fail silently
  // and the sheet has no recent entries. Supabase trigger_log is the backup.
  const runMap = {};

  // Try Sheets first
  try {
    const monitorRows = await getValues(SPREADSHEET_ID, SHEETS.TRIGGER_MONITOR);
    if (monitorRows && monitorRows.length > 1) {
      const todayRuns = monitorRows.slice(1).filter(row => {
        const ts = new Date(row[0]);
        return !isNaN(ts.getTime()) && ts >= windowStart && ts <= now;
      });
      for (const row of todayRuns) {
        const name = row[1] || '';
        const status = row[2] || '';
        const duration = row[5] || '';
        const error = row[7] || '';
        runMap[name] = { status, duration, error };
      }
    }
  } catch (e) {
    console.warn('[emails] Trigger_Monitor read failed:', e.message);
  }

  // If Sheets had few results, try Supabase as fallback
  if (Object.keys(runMap).length < 3) {
    console.log('[emails] Few Sheets results, checking Supabase trigger_log...');
    const db = getEmailDb();
    const dbRuns = await db.getRecentTriggerRuns(24);
    if (dbRuns && dbRuns.length > 0) {
      for (const row of dbRuns) {
        const name = row.trigger_name || '';
        if (runMap[name]) continue; // Sheets data takes precedence
        runMap[name] = {
          status: row.status || '',
          duration: row.duration_sec != null ? String(row.duration_sec) : '',
          error: row.error_message || '',
        };
      }
      console.log(`[emails] Supabase added ${dbRuns.length} trigger entries`);
    }
  }

  if (Object.keys(runMap).length === 0) {
    console.warn('[emails] No trigger data found in Sheets or Supabase');
    return;
  }

  // Expected triggers for today (use ET since schedule is ET-based)
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = etNow.getDay(); // 0=Sun
  const expectedDaily = [
    'trigger1', 'trigger2', 'trigger3', 'trigger4',
    'trigger6', 'trigger7', 'trigger8', 'trigger9',
    'trigger10', 'trigger11', 'trigger12', 'trigger14',
  ];
  if (dayOfWeek === 0) expectedDaily.push('trigger13'); // Sunday weekly summary

  // Categorize
  const passed = [];
  const failed = [];
  const missing = [];

  for (const name of expectedDaily) {
    const run = runMap[name];
    if (!run) {
      missing.push(name);
    } else if (run.status === 'FAILED') {
      failed.push({ name, error: run.error, duration: run.duration });
    } else {
      passed.push({ name, duration: run.duration });
    }
  }

  const allGood = failed.length === 0 && missing.length === 0;
  const statusEmoji = allGood ? '✅' : '🚨';
  const statusText = allGood ? 'All Clear' : `${failed.length} Failed, ${missing.length} Missing`;

  // Build email
  const todayFmt = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  let html = `
<div style="font-family:'Segoe UI',Roboto,sans-serif;max-width:600px;margin:auto;padding:20px;">
  <h1 style="color:${allGood ? '#2d6a4f' : '#d00000'};">${statusEmoji} Shadow Bets — Daily Health Check</h1>
  <p style="color:#666;">${todayFmt}</p>
  <p style="font-size:18px;font-weight:bold;padding:10px;background:${allGood ? '#d8f3dc' : '#ffd6d6'};border-radius:8px;">
    ${statusText} — ${passed.length}/${expectedDaily.length} triggers ran successfully
  </p>`;

  if (failed.length > 0) {
    html += `<h2 style="color:#d00000;">Failed Triggers</h2>
<table style="width:100%;border-collapse:collapse;">
<tr style="background:#d00000;color:white;"><th style="padding:6px;">Trigger</th><th style="padding:6px;">Duration</th><th style="padding:6px;">Error</th></tr>`;
    for (const f of failed) {
      const errShort = (f.error || 'Unknown error').substring(0, 120);
      html += `<tr style="background:#fff0f0;"><td style="padding:6px;border:1px solid #ddd;">${f.name}</td><td style="padding:6px;border:1px solid #ddd;">${f.duration}s</td><td style="padding:6px;border:1px solid #ddd;font-size:12px;">${errShort}</td></tr>`;
    }
    html += '</table>';
  }

  if (missing.length > 0) {
    html += `<h2 style="color:#e85d04;">Missing Triggers</h2>
<p>These triggers were expected today but never ran:</p>
<p style="font-size:16px;"><strong>${missing.join(', ')}</strong></p>`;
  }

  if (passed.length > 0) {
    html += `<h2 style="color:#2d6a4f;">Passed (${passed.length})</h2>
<p style="color:#666;font-size:13px;">${passed.map(p => `${p.name} (${p.duration}s)`).join(' · ')}</p>`;
  }

  html += `
  <hr style="margin-top:20px;border:none;border-top:1px solid #eee;">
  <p style="font-size:11px;color:#999;">Shadow Bets Health Check — trigger16</p>
</div>`;

  // Only send email if something is wrong — no news is good news
  if (allGood) {
    console.log(`[emails] Health check: All Clear (${passed.length}/${expectedDaily.length} passed). No email sent.`);
    return;
  }

  const transporter = getTransporter();
  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: `${statusEmoji} Shadow Bets Health — ${statusText} — ${todayFmt}`,
    html,
  });

  console.log(`[emails] Health check sent: ${statusText} (${passed.length} passed, ${failed.length} failed, ${missing.length} missing)`);
}
