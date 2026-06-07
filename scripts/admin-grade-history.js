#!/usr/bin/env node
'use strict';
/**
 * scripts/admin-grade-history.js
 *
 * Grade ungraded picks in a historical date window using ESPN scoreboards.
 * Use case: the 2026-04-24 to 2026-06-04 dual-write outage left ~1065 picks
 * in the recovered window with result=null because the existing nightly
 * grader only looks at a 2-day window of Yesterday_Results. This script
 * fetches per-league per-date scoreboards from ESPN (no API key needed,
 * free public endpoint), matches games to ungraded picks, and writes
 * results to BOTH Supabase performance_log and the Sheets Performance Log
 * so the two stay in sync.
 *
 * Usage:
 *   node scripts/admin-grade-history.js --from 2026-04-24 --to 2026-06-04
 *   node scripts/admin-grade-history.js --from 2026-04-24 --to 2026-06-04 --dry-run
 *   node scripts/admin-grade-history.js --from 2026-04-24 --to 2026-06-04 --report-only
 *
 * Flags:
 *   --from YYYY-MM-DD     Inclusive start (required)
 *   --to   YYYY-MM-DD     Inclusive end   (required)
 *   --dry-run             Compute grades but do not write back
 *   --report-only         Just print the distribution of ungraded rows, no fetches
 *   --skip-sheets         Only update Supabase, not Sheets
 *   --limit N             Cap how many picks to attempt grading (for testing)
 */

const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const db = require('../src/db');
const { getValues, setValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const { determineBetResult, calculateUnitReturn } = require('../src/predictions');

// ── Arg parsing ────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const bool = n => args.includes(`--${n}`);

const FROM = flag('from');
const TO   = flag('to');
const DRY_RUN     = bool('dry-run');
const REPORT_ONLY = bool('report-only');
const SKIP_SHEETS = bool('skip-sheets');
const LIMIT = parseInt(flag('limit')) || Infinity;

if (!FROM || !TO || !/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error('Required: --from YYYY-MM-DD --to YYYY-MM-DD');
  process.exit(2);
}

// ── ESPN scoreboard config ─────────────────────────────────────
const ESPN = {
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
};

function dateToYYYYMMDD(iso) { return iso.replace(/-/g, ''); }
function shiftIsoDate(iso, deltaDays) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Team-name normalization for fuzzy matching across APIs.
function normalizeTeam(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function teamLast(name) {
  const norm = normalizeTeam(name);
  const parts = norm.split(' ');
  return parts[parts.length - 1];
}
function teamsMatch(a, b) {
  if (!a || !b) return false;
  const na = normalizeTeam(a), nb = normalizeTeam(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return teamLast(a) === teamLast(b);
}

// ── Fetch ESPN scoreboard for a league + date ──────────────────
async function fetchEspnScoreboard(league, dateYYYYMMDD) {
  const url = `${ESPN[league]}?dates=${dateYYYYMMDD}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      console.warn(`[grade-history] ESPN ${league} ${dateYYYYMMDD}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const events = data.events || [];
    const games = [];
    for (const ev of events) {
      const comp = (ev.competitions && ev.competitions[0]) || null;
      if (!comp) continue;
      const status = (comp.status && comp.status.type && comp.status.type.name) || '';
      const completed = (comp.status && comp.status.type && comp.status.type.completed) === true;
      const competitors = comp.competitors || [];
      let home = null, away = null;
      for (const c of competitors) {
        const teamName = (c.team && (c.team.displayName || c.team.name)) || '';
        const score = parseFloat(c.score);
        const side = (c.homeAway || '').toLowerCase();
        const entry = { name: teamName, score: Number.isFinite(score) ? score : null };
        if (side === 'home') home = entry;
        else if (side === 'away') away = entry;
      }
      if (!home || !away) continue;
      games.push({ league, date: dateYYYYMMDD, status, completed, home, away });
    }
    return games;
  } catch (err) {
    console.warn(`[grade-history] ESPN ${league} ${dateYYYYMMDD} fetch failed: ${err.message}`);
    return [];
  }
}

// ── Step 1: pull ungraded rows from Supabase in window ────────
async function loadUngraded(from, to) {
  const sb = db.getClient();
  const rows = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('performance_log')
      .select('id, date, league, game, market, pick, line, odds, final_units')
      .gte('date', from)
      .lte('date', to)
      .is('result', null)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Supabase ungraded query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

// ── Step 2: group ungraded by (date, league) and report ───────
function distributionReport(rows) {
  const byDate = {};
  const byLeague = {};
  const byDateLeague = {};
  for (const r of rows) {
    byDate[r.date] = (byDate[r.date] || 0) + 1;
    byLeague[r.league] = (byLeague[r.league] || 0) + 1;
    const k = `${r.date}|${r.league}`;
    byDateLeague[k] = (byDateLeague[k] || 0) + 1;
  }
  const topDates = Object.entries(byDate).sort((a,b) => b[1] - a[1]).slice(0, 10);
  console.log(`[grade-history] Total ungraded in window: ${rows.length}`);
  console.log(`[grade-history] By league:`, JSON.stringify(byLeague));
  console.log(`[grade-history] Top 10 dates by ungraded count:`);
  for (const [d, n] of topDates) console.log(`    ${d}: ${n}`);
  return { byDateLeague };
}

// ── Step 3: grade against ESPN scoreboard ─────────────────────
async function gradeWindow(rows, byDateLeague) {
  const updates = []; // {id, date, game, market, pick, result, unit_return, league}
  const dateLeaguePairs = Object.keys(byDateLeague).sort();
  let processed = 0;
  for (const pair of dateLeaguePairs) {
    const [date, league] = pair.split('|');
    if (!ESPN[league]) {
      console.warn(`[grade-history] No ESPN endpoint for league ${league}, skipping`);
      continue;
    }
    // 2026-06-06: fetch a ±1 day window. The pick's stored 'date' is the
    // US-local game date but ESPN groups events by UTC day, so a west-coast
    // game that starts at 10 PM PT plays at 5 AM UTC the next day. Without
    // the ±1 window, those games come back as empty / wrong-game.
    const prev = shiftIsoDate(date, -1);
    const next = shiftIsoDate(date, +1);
    const [g0, g1, g2] = await Promise.all([
      fetchEspnScoreboard(league, dateToYYYYMMDD(prev)),
      fetchEspnScoreboard(league, dateToYYYYMMDD(date)),
      fetchEspnScoreboard(league, dateToYYYYMMDD(next)),
    ]);
    const games = [...g0, ...g1, ...g2];
    // Small politeness delay between (date,league) pairs
    await new Promise(r => setTimeout(r, 200));

    const picksToday = rows.filter(r => r.date === date && r.league === league);
    let matched = 0, unmatched = 0, nonFinal = 0;
    // Debug: log a few unmatched examples per (date,league) so we can see what
    // names we're comparing against ESPN.
    let dbgUnmatched = 0;
    for (const pick of picksToday) {
      const [teamA, teamB] = pick.game.split(' @ ').map(s => s.trim());
      // Try both orientations: (away=teamA, home=teamB) AND (home=teamA, away=teamB).
      // The 2026-04-23 column shift commit moved things around in Sheets and the
      // game string stored in Supabase may not always follow the documented order.
      let game = games.find(g => teamsMatch(g.home.name, teamB) && teamsMatch(g.away.name, teamA));
      let homeTeam = teamB, awayTeam = teamA, flipped = false;
      if (!game) {
        game = games.find(g => teamsMatch(g.home.name, teamA) && teamsMatch(g.away.name, teamB));
        if (game) { homeTeam = teamA; awayTeam = teamB; flipped = true; }
      }
      if (!game) {
        if (dbgUnmatched < 2) {
          const espnNames = games.map(g => `${g.away.name}@${g.home.name}`).slice(0, 5);
          console.log(`[grade-history]   unmatched pick game="${pick.game}" ESPN=${JSON.stringify(espnNames)}`);
        }
        dbgUnmatched++;
        unmatched++; continue;
      }
      if (!game.completed || game.home.score == null || game.away.score == null) { nonFinal++; continue; }

      const betResult = determineBetResult(
        pick.market,
        pick.pick,
        pick.line,
        homeTeam,
        awayTeam,
        game.home.score,
        game.away.score,
      );
      if (!betResult) { unmatched++; continue; }
      const ur = calculateUnitReturn(betResult, pick.final_units || 0, pick.odds, pick.market);
      updates.push({
        id: pick.id,
        date: pick.date,
        league: pick.league,
        game: pick.game,
        market: pick.market,
        pick: pick.pick,
        result: betResult,
        unit_return: parseFloat(ur.toFixed(2)),
      });
      matched++;
      if (updates.length >= LIMIT) break;
    }
    console.log(`[grade-history] ${pair}: ${picksToday.length} picks, ${matched} graded, ${unmatched} unmatched, ${nonFinal} not-final`);
    processed++;
    if (updates.length >= LIMIT) break;
  }
  console.log(`[grade-history] Processed ${processed} date+league pairs`);
  return updates;
}

// ── Step 4: write to Supabase ─────────────────────────────────
async function writeSupabase(updates) {
  const sb = db.getClient();
  let ok = 0, fail = 0;
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    for (const u of batch) {
      const { error } = await sb
        .from('performance_log')
        .update({ result: u.result, unit_return: u.unit_return, prediction_correct: u.result === 'W' ? true : u.result === 'L' ? false : null })
        .eq('id', u.id);
      if (error) {
        fail++;
        if (fail <= 5) console.warn(`[grade-history] Supabase update fail id=${u.id}: ${error.message}`);
      } else ok++;
    }
    console.log(`[grade-history] Supabase progress: ${ok + fail}/${updates.length} (${ok} ok, ${fail} fail)`);
  }
  return { ok, fail };
}

// ── Step 5: write back to Sheets Performance Log ──────────────
async function writeSheets(updates) {
  console.log(`[grade-history] Reading Performance Log for Sheets sync...`);
  const sheet = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!sheet || sheet.length < 2) return { matched: 0 };
  // Build update index keyed by date+league+away+home+market+pick (with normalized whitespace)
  const idx = new Map();
  for (const u of updates) {
    const [away, home] = u.game.split(' @ ').map(s => s.trim());
    const key = `${u.date}|${u.league}|${away}|${home}|${u.market}|${u.pick}`;
    idx.set(key, u);
  }
  let matched = 0;
  for (let i = 1; i < sheet.length; i++) {
    const r = sheet[i];
    if (!r) continue;
    const rawDate = String(r[0] || '');
    const iso = rawDate.replace(/(\d+)\/(\d+)\/(\d+)/, (_, m, d, y) => `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    const league = String(r[1] || '').trim();
    const away   = String(r[3] || '').trim();
    const home   = String(r[4] || '').trim();
    const market = String(r[6] || '').trim();
    const pick   = String(r[7] || '').trim();
    const existing = (r[16] || '').toString().trim().toUpperCase();
    if (existing === 'W' || existing === 'L' || existing === 'P') continue;
    const key = `${iso}|${league}|${away}|${home}|${market}|${pick}`;
    const u = idx.get(key);
    if (!u) continue;
    while (sheet[i].length < 18) sheet[i].push('');
    sheet[i][16] = u.result;
    sheet[i][17] = u.unit_return;
    matched++;
  }
  console.log(`[grade-history] Sheets match: ${matched} rows updated locally`);
  if (matched > 0) {
    await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', sheet);
    console.log(`[grade-history] Sheets write complete`);
  }
  return { matched };
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log('=== admin-grade-history starting ===');
  console.log(`FROM=${FROM} TO=${TO} DRY_RUN=${DRY_RUN} REPORT_ONLY=${REPORT_ONLY} SKIP_SHEETS=${SKIP_SHEETS} LIMIT=${LIMIT}`);
  if (!db.isEnabled()) {
    console.error('[grade-history] Supabase not configured — abort');
    process.exit(1);
  }

  const ungraded = await loadUngraded(FROM, TO);
  if (ungraded.length === 0) {
    console.log('[grade-history] No ungraded rows in window. Done.');
    process.exit(0);
  }
  const { byDateLeague } = distributionReport(ungraded);
  if (REPORT_ONLY) { console.log('[grade-history] --report-only, exiting'); process.exit(0); }

  const updates = await gradeWindow(ungraded, byDateLeague);
  console.log(`[grade-history] Total graded: ${updates.length} of ${ungraded.length} ungraded`);
  if (updates.length === 0) { console.log('[grade-history] Nothing to write'); process.exit(0); }

  // Result breakdown
  const breakdown = { W: 0, L: 0, P: 0 };
  for (const u of updates) breakdown[u.result] = (breakdown[u.result] || 0) + 1;
  console.log(`[grade-history] Grade breakdown:`, JSON.stringify(breakdown));

  if (DRY_RUN) {
    console.log('[grade-history] DRY_RUN — sample (first 3):');
    for (const u of updates.slice(0, 3)) console.log('   ', JSON.stringify(u));
    process.exit(0);
  }

  console.log('[grade-history] Writing Supabase updates...');
  const sb = await writeSupabase(updates);
  console.log(`[grade-history] Supabase: ${sb.ok} ok, ${sb.fail} failed`);

  if (!SKIP_SHEETS) {
    console.log('[grade-history] Writing Sheets updates...');
    const sh = await writeSheets(updates);
    console.log(`[grade-history] Sheets: ${sh.matched} matched and written`);
  }

  console.log('=== admin-grade-history complete ===');
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
