#!/usr/bin/env node
'use strict';
/**
 * evening-digest.js — the night-before "tomorrow's picks" email.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bettor (Nick) wakes up too late to place the morning EPL slate. This job
 * runs at ~9:30pm PT (GitHub Actions cron '30 4 * * *' UTC) and emails the full
 * slate of picks for TOMORROW, across every league in the shared ledger — so the
 * bets can be reviewed the night before and the earliest available lines are the
 * ones captured.
 *
 * SOURCE OF TRUTH
 * ---------------
 * Reads the SHARED Supabase performance_log directly (the same table ShadowB and
 * ShadowB-Soccer both write, league-tagged). No Google Sheets, no Odds API — this
 * job only reports what has already been generated. If US (MLB/NBA/...) generation
 * still runs same-day-morning, tomorrow's US rows won't exist yet and the email
 * will show only the leagues that generate ahead (EPL). Once US generation is
 * shifted to the night before, those rows appear here automatically — no change
 * needed to this script.
 *
 * "TOMORROW" is computed in America/Los_Angeles (the bettor's timezone). At the
 * 9:30pm PT fire time, that's the next calendar day's slate. Each pick's `date`
 * column is already the local slate date for both systems (EPL: UTC match date;
 * US: ET game date), so a single `date = <tomorrow>` filter is correct for both.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD,
 *      EMAIL_RECIPIENTS (comma-separated).
 *
 * Local dry-run (prints the HTML, sends nothing):
 *   node scripts/evening-digest.js --dry-run
 * Target a specific date instead of "tomorrow":
 *   node scripts/evening-digest.js --dry-run --date=2026-08-24
 */
try { require('dotenv').config(); } catch (_) { /* CI provides env directly */ }

const nodemailer = require('nodemailer');
const db = require('../src/db');

// ── Tomorrow's date, in the bettor's timezone ────────────────────
const BETTOR_TZ = 'America/Los_Angeles';

/** YYYY-MM-DD for `date` shifted by dayOffset, evaluated in BETTOR_TZ. */
function slateDate(now, dayOffset) {
  // en-CA gives ISO YYYY-MM-DD; do the +1 day in the target tz by first getting
  // the tz-local Y/M/D, then constructing a UTC date from those parts and adding.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BETTOR_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  const base = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

// ── Formatting helpers ───────────────────────────────────────────
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtOdds(o) {
  if (o == null || o === '') return '';
  const n = Number(o);
  if (!Number.isFinite(n)) return esc(o);
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtUnits(u) {
  const n = Number(u);
  if (!Number.isFinite(n)) return '';
  return `${n.toFixed(2)}u`;
}

// League display order + emoji. Unknown leagues fall to the end, alphabetically.
const LEAGUE_ORDER = ['MLB', 'NBA', 'NHL', 'NFL', 'EPL', 'LALIGA', 'SERIEA', 'BUNDESLIGA', 'UCL', 'MLS'];
const LEAGUE_EMOJI = {
  MLB: '&#9918;', NBA: '&#127936;', NHL: '&#127954;', NFL: '&#127944;',
  EPL: '&#9917;', LALIGA: '&#9917;', SERIEA: '&#9917;', BUNDESLIGA: '&#9917;',
  UCL: '&#9917;', MLS: '&#9917;',
};
function leagueRank(l) {
  const i = LEAGUE_ORDER.indexOf(l);
  return i === -1 ? LEAGUE_ORDER.length : i;
}

function buildHtml(dateStr, rows) {
  const dateFmt = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  const approvedCount = rows.filter((r) => (r.approval_status || '') === 'approved').length;

  // Group: league -> game -> [rows]
  const byLeague = {};
  for (const r of rows) {
    const lg = r.league || 'Other';
    (byLeague[lg] = byLeague[lg] || {});
    const g = r.game || '(unknown game)';
    (byLeague[lg][g] = byLeague[lg][g] || []).push(r);
  }
  const leagues = Object.keys(byLeague).sort((a, b) => leagueRank(a) - leagueRank(b) || a.localeCompare(b));

  const marketRank = { moneyline: 0, spread: 1, total: 2 };

  let body = '';
  for (const lg of leagues) {
    const games = byLeague[lg];
    const gameKeys = Object.keys(games).sort();
    const lgPickCount = Object.values(games).reduce((n, arr) => n + arr.length, 0);
    body += `<h2 style="color:#16213e;border-bottom:2px solid #0f3460;padding-bottom:4px;margin-bottom:8px;">`
      + `${LEAGUE_EMOJI[lg] || ''} ${esc(lg)} `
      + `<span style="font-size:13px;color:#888;font-weight:normal;">${gameKeys.length} game${gameKeys.length !== 1 ? 's' : ''} &middot; ${lgPickCount} pick${lgPickCount !== 1 ? 's' : ''}</span></h2>`;

    for (const gk of gameKeys) {
      const picks = games[gk].slice().sort((a, b) =>
        (marketRank[a.market] ?? 9) - (marketRank[b.market] ?? 9));
      body += `<div style="margin:0 0 14px;">`;
      body += `<div style="font-weight:bold;font-size:15px;color:#1a1a2e;margin-bottom:2px;">${esc(gk)}</div>`;
      body += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
      body += '<tr style="background:#0f3460;color:white;">'
        + '<th style="padding:5px 6px;text-align:left;">Market</th>'
        + '<th style="padding:5px 6px;text-align:left;">Pick</th>'
        + '<th style="padding:5px 6px;text-align:right;">Odds</th>'
        + '<th style="padding:5px 6px;text-align:right;">Stake</th>'
        + '<th style="padding:5px 6px;text-align:center;">Conf</th>'
        + '<th style="padding:5px 6px;text-align:center;">Status</th></tr>';
      for (const p of picks) {
        const approved = (p.approval_status || '') === 'approved';
        const statusLabel = approved ? '&#9989; play' : '&#128065; track';
        const rowBg = approved ? 'background:#f0fdf4;' : '';
        const conf = p.confidence == null ? '' : `${esc(p.confidence)}/10`;
        const confStyle = Number(p.confidence) >= 8 ? 'color:#27ae60;font-weight:bold;' : '';
        body += `<tr style="${rowBg}">`
          + `<td style="padding:5px 6px;border-bottom:1px solid #eee;">${esc(p.market)}</td>`
          + `<td style="padding:5px 6px;border-bottom:1px solid #eee;"><strong>${esc(p.pick)}</strong></td>`
          + `<td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:right;">${fmtOdds(p.odds)}</td>`
          + `<td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:right;">${fmtUnits(p.final_units)}</td>`
          + `<td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:center;${confStyle}">${conf}</td>`
          + `<td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:center;">${statusLabel}</td>`
          + `</tr>`;
      }
      body += '</table></div>';
    }
  }

  if (rows.length === 0) {
    body = '<p style="font-size:15px;color:#666;padding:16px;background:#f8f9fa;border-radius:6px;">'
      + 'No picks are in the ledger for tomorrow yet. If you expected games, the generator '
      + 'for that league may not have run — worth a check. (Leagues that generate same-day '
      + 'will not appear here until their generation is moved to the night before.)</p>';
  }

  return `<!DOCTYPE html><html><head><style>
    body { font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 680px; margin: 0 auto; color:#1a1a2e; }
    table { width:100%; border-collapse:collapse; }
  </style></head><body>
    <h1 style="margin-bottom:2px;">&#127769; Shadow Bets — Tomorrow's Picks</h1>
    <p style="color:#666;margin-top:0;">${dateFmt}</p>
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;margin-bottom:20px;font-size:14px;">
      <strong>${rows.length}</strong> pick${rows.length !== 1 ? 's' : ''} across
      <strong>${leagues.length}</strong> league${leagues.length !== 1 ? 's' : ''}
      &middot; <strong>${approvedCount}</strong> recommended play${approvedCount !== 1 ? 's' : ''}
      <span style="color:#888;">(&#9989; = approved play &middot; &#128065; = tracking only)</span>
    </div>
    ${body}
    <div style="color:#888;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:10px;">
      <p>Early lines — sent the night before so tomorrow's slate can be placed on time. For informational purposes only.</p>
    </div>
  </body></html>`;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dateArg = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];

  if (!db.isEnabled()) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
  }
  const sb = db.getClient();

  const dateStr = dateArg || slateDate(new Date(), 1);
  console.log(`[digest] Building tomorrow's picks email for date=${dateStr} (${BETTOR_TZ})`);

  const { data, error } = await sb.from('performance_log')
    .select('league, date, game, market, pick, line, odds, final_units, confidence, approval_status, status, start_time')
    .eq('date', dateStr)
    .order('league', { ascending: true })
    .order('start_time', { ascending: true });
  if (error) throw new Error(`performance_log query failed: ${error.message}`);

  const rows = data || [];
  const leagues = [...new Set(rows.map((r) => r.league))];
  console.log(`[digest] ${rows.length} picks for ${dateStr} across ${leagues.length} league(s): ${leagues.join(', ') || '(none)'}`);

  const html = buildHtml(dateStr, rows);

  const dateFmt = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const approvedCount = rows.filter((r) => (r.approval_status || '') === 'approved').length;
  const subject = rows.length
    ? `🌙 Tomorrow's Picks (${dateFmt}) — ${rows.length} picks${approvedCount ? `, ${approvedCount} plays` : ''}`
    : `🌙 Tomorrow's Picks (${dateFmt}) — none in the ledger yet`;

  if (dryRun) {
    console.log(`[digest] DRY RUN — would send: "${subject}"`);
    console.log(html);
    return;
  }

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
  const recipients = (process.env.EMAIL_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set.');
  if (!recipients.length) throw new Error('EMAIL_RECIPIENTS not set.');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: GMAIL_USER,
    to: recipients.join(', '),
    subject,
    html,
  });
  console.log(`[digest] Sent to ${recipients.length} recipient(s): ${recipients.join(', ')}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[digest] FAILED:', e.message); process.exit(1); });
}

module.exports = { slateDate, buildHtml, fmtOdds, fmtUnits };
