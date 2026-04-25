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
  const recentRows = perfRows.slice(-8); // last 7 days + header

  const tableRows = recentRows.slice(1).map(r =>
    `<tr><td>${r[0] || ''}</td><td>${r[1] || ''}</td><td>${r[2] || ''}</td><td>${r[3] || ''}</td></tr>`
  ).join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif;">
  <h1>&#128202; Shadow Bets Weekly Performance</h1>
  <table style="width:100%;border-collapse:collapse;">
    <tr style="background:#0f3460;color:white;">
      <th style="padding:8px;">Date</th><th style="padding:8px;">Record</th><th style="padding:8px;">ROI</th><th style="padding:8px;">Bankroll</th>
    </tr>
    ${tableRows || '<tr><td colspan="4">No data yet.</td></tr>'}
  </table>
</body>
</html>
`;

  const transporter = getTransporter();
  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: '📊 Shadow Bets Weekly Performance Summary',
    html,
  });

  const ts = new Date().toISOString();
  await appendRows(SPREADSHEET_ID, SHEETS.EMAIL_LOG, [
    [ts, 'PerformanceSummary', EMAIL_RECIPIENTS.join(','), 'sent', ''],
  ]);

  console.log('[emails] Performance summary sent');
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

  const monitorRows = await getValues(SPREADSHEET_ID, SHEETS.TRIGGER_MONITOR);
  if (!monitorRows || monitorRows.length <= 1) {
    console.warn('[emails] No Trigger_Monitor data found');
    return;
  }

  // Today's date boundaries (UTC, since timestamps are ISO)
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // Filter to today's runs
  const todayRuns = monitorRows.slice(1).filter(row => {
    const ts = new Date(row[0]);
    return ts >= todayStart && ts <= todayEnd;
  });

  // Build a map of trigger name → { status, error, duration }
  // If a trigger ran multiple times, keep the latest
  const runMap = {};
  for (const row of todayRuns) {
    const name = row[1] || '';
    const status = row[2] || '';
    const duration = row[5] || '';
    const error = row[7] || '';
    runMap[name] = { status, duration, error };
  }

  // Expected triggers for today
  const dayOfWeek = now.getDay(); // 0=Sun
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

  const transporter = getTransporter();
  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(', '),
    subject: `${statusEmoji} Shadow Bets Health — ${statusText} — ${todayFmt}`,
    html,
  });

  console.log(`[emails] Health check sent: ${statusText} (${passed.length} passed, ${failed.length} failed, ${missing.length} missing)`);
}
