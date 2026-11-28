// Nightly app check — opens the LIVE app the way Nick does, right before his
// 9 PM PT betting window, and emails him only if something is wrong.
//
// Added 2026-11-22 after a review found the app taking ~5s to open and default
// filters silently hiding picks. Nothing here changes data — it only reads the
// public app and ESPN's public scoreboard.
//
// Checks:
//   1. /api/data answers, and fast enough
//   2. the app shows picks fast (first open, and again with the saved copy)
//   3. the app opens on ALL leagues, and every league with picks has a chip
//   4. every tomorrow game the model picked has ML + spread + total
//   5. every tomorrow ESPN game in a sport we cover has picks at all
//   6. no page errors
//
// Run: APP_URL=https://... node scripts/app-check.js
// Needs `playwright` (the workflow installs it; not a repo dependency).

const nodemailer = require('nodemailer');

const APP_URL = (process.env.APP_URL || 'https://shadow-b-5x.vercel.app').replace(/\/$/, '');
const LIMITS = {
  apiMs: 4000,        // /api/data response
  firstOpenMs: 6000,  // fresh phone, nothing saved
  reopenMs: 2000,     // saved copy should show near-instantly
};
const US = ['NBA', 'NHL', 'NFL', 'MLB'];
const ESPN = { NBA: 'basketball/nba', NHL: 'hockey/nhl', NFL: 'football/nfl', MLB: 'baseball/mlb' };

const ptDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
};
const nick = (team) => (team || '').trim().split(/\s+/).pop().toLowerCase();
const marketOf = (p) => {
  const m = (p.betType || p.market || '').toLowerCase();
  return m === 'moneyline' ? 'ML' : m === 'spread' ? 'spread' : m === 'total' ? 'total' : null;
};

async function checkApi(problems, info) {
  const t0 = Date.now();
  let res, body;
  try {
    res = await fetch(`${APP_URL}/api/data`, { headers: { 'cache-control': 'no-cache' } });
    body = await res.json();
  } catch (e) {
    problems.push(`The app's data feed didn't answer (${e.message}).`);
    return null;
  }
  const ms = Date.now() - t0;
  info.push(`Data feed: ${ms} ms`);
  if (!res.ok || body.error) { problems.push(`The app's data feed returned an error: ${body.error || res.status}.`); return null; }
  if (ms > LIMITS.apiMs) problems.push(`The app's data feed is slow: ${(ms / 1000).toFixed(1)}s (limit ${LIMITS.apiMs / 1000}s).`);
  if (!Array.isArray(body.todayPicks)) { problems.push('The data feed came back without any picks list.'); return null; }
  return body.todayPicks;
}

function checkCoverage(picks, date, problems, info) {
  const games = {};
  for (const p of picks) {
    if (p.isoDate !== date || !US.includes(p.league)) continue;
    const k = `${p.league} ${p.away} @ ${p.home}`;
    (games[k] = games[k] || new Set()).add(marketOf(p));
  }
  info.push(`Tomorrow (${date}): ${Object.keys(games).length} US games with picks`);
  for (const [g, ms] of Object.entries(games)) {
    const missing = ['ML', 'spread', 'total'].filter(m => !ms.has(m));
    if (missing.length) problems.push(`${g} is missing: ${missing.join(', ')}.`);
  }
  return games;
}

async function checkEspn(games, date, problems) {
  const picked = Object.keys(games).map(k => k.toLowerCase());
  for (const lg of US) {
    let j;
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[lg]}/scoreboard?dates=${date.replace(/-/g, '')}`);
      if (!r.ok) continue;
      j = await r.json();
    } catch { continue; } // ESPN hiccup is not Nick's problem
    for (const ev of j.events || []) {
      const st = ev.status?.type?.name || '';
      if (/POSTPONED|CANCELED|CANCELLED/.test(st)) continue;
      const c = ev.competitions?.[0]?.competitors || [];
      const away = c.find(x => x.homeAway === 'away')?.team?.displayName;
      const home = c.find(x => x.homeAway === 'home')?.team?.displayName;
      if (!away || !home) continue;
      const hit = picked.some(k => k.startsWith(lg.toLowerCase()) && k.includes(nick(away)) && k.includes(nick(home)));
      if (hit) continue;
      // No line posted yet (common when a team played the night before) means
      // the model can't pick yet — the ~4:30 AM PT morning run tops it up.
      const noLine = !(ev.competitions?.[0]?.odds || []).length;
      problems.push(noLine
        ? `${lg} ${away} @ ${home} (tomorrow) has no picks yet — betting sites haven't posted a line. The 4:30 AM PT run should add it; check before the 5:30 AM window.`
        : `${lg} ${away} @ ${home} (tomorrow) has no picks at all.`);
    }
  }
}

// Tap the Picks tab until it's actually selected — a tap that lands before the
// app has finished starting up is silently lost.
async function openPicks(page, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await page.click('.tabs button:has-text("Picks")', { timeout }).catch(() => {});
    if (await page.locator('.tabs button.on:has-text("Picks")').count()) return;
    await page.waitForTimeout(100);
  }
  throw new Error('could not open the Picks tab');
}

async function checkBrowser(picks, date, problems, info) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ShadowBetsAppCheck',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    // First open: nothing saved on the phone.
    let t0 = Date.now();
    await page.goto(APP_URL, { waitUntil: 'commit' });
    await openPicks(page, LIMITS.firstOpenMs * 3);
    await page.waitForSelector('.aleagues', { timeout: LIMITS.firstOpenMs * 3 });
    let ms = Date.now() - t0;
    info.push(`First open: ${ms} ms`);
    if (ms > LIMITS.firstOpenMs) problems.push(`The app took ${(ms / 1000).toFixed(1)}s to show picks on a fresh open (limit ${LIMITS.firstOpenMs / 1000}s).`);
    if (await page.getByText('LOAD FAILED').count()) problems.push('The app showed "LOAD FAILED".');

    // Opens on ALL leagues?
    const sel = (await page.locator('.aleagues button.sel').first().innerText().catch(() => '')).trim();
    if (!/^ALL/.test(sel)) problems.push(`The app opened filtered to "${sel.split('\n')[0]}" instead of ALL leagues.`);

    // Every league with picks in the shown range has a chip. Look at Tomorrow
    // (the night-before window) regardless of what the app defaulted to.
    await page.click('button:text-is("Tomorrow")').catch(() => {});
    const leagues = [...new Set(picks.filter(p => p.isoDate === date).map(p => p.league).filter(Boolean))];
    let chips = '';
    for (let i = 0; i < 10; i++) { // give the screen a few seconds to settle
      await page.waitForTimeout(500);
      chips = (await page.locator('.aleagues').first().innerText()).toUpperCase();
      if (leagues.every(lg => chips.includes(lg))) break;
    }
    for (const lg of leagues) if (!chips.includes(lg)) problems.push(`${lg} has picks tomorrow but no ${lg} button shows on the Picks tab (buttons: ${chips.replace(/\s+/g, " ")}).`);

    // Reopen: the saved copy should show near-instantly.
    await page.waitForTimeout(1500); // let the fresh copy save
    t0 = Date.now();
    await page.reload({ waitUntil: 'commit' });
    await openPicks(page, 15000);
    await page.waitForSelector('.aleagues', { timeout: 15000 });
    ms = Date.now() - t0;
    info.push(`Reopen: ${ms} ms`);
    if (ms > LIMITS.reopenMs) problems.push(`Reopening the app took ${(ms / 1000).toFixed(1)}s (limit ${LIMITS.reopenMs / 1000}s) — the saved copy may not be working.`);
  } catch (e) {
    problems.push(`The app didn't finish opening: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
  for (const e of [...new Set(errors)].slice(0, 5)) problems.push(`Page error: ${e}`);
}

async function email(problems, info) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const to = (process.env.EMAIL_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !to.length) { console.warn('[app-check] email not configured — skipping.'); return; }
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<p><b>Tonight's app check found ${problems.length} problem(s):</b></p>
<ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
<p style="color:#666">${info.map(esc).join(' · ')}</p>
<p style="color:#666">Paste this email into a Claude session to get it fixed.</p>`;
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: GMAIL_USER, to: to.join(', '), subject: `⚠️ Shadow Bets app check: ${problems.length} problem(s)`, html });
  console.log('[app-check] alert email sent.');
}

async function main() {
  const problems = [], info = [];
  const tomorrow = ptDate(1);
  const picks = await checkApi(problems, info);
  if (picks) {
    const games = checkCoverage(picks, tomorrow, problems, info);
    await checkEspn(games, tomorrow, problems);
  }
  await checkBrowser(picks || [], tomorrow, problems, info);

  console.log(info.join('\n'));
  if (!problems.length) { console.log('[app-check] all good — no email.'); return; }
  console.log(`[app-check] ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  await email(problems, info);
  process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
