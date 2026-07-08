import { google } from 'googleapis';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// This route serves the MAIN load: today's picks, props, and today's games.
// Graded history (Results tab) lives in /api/results and is loaded lazily by
// the client after this returns.
//
// `force-dynamic` keeps the function running per-request (no build-time
// prerender / no frozen data). Edge caching is handled purely by the
// Cache-Control header on the response below — Vercel's CDN caches the
// response for 60s and serves it stale for up to 5 min while refreshing.
export const dynamic = 'force-dynamic';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

async function getSheetsClient() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getValues(sheets, sheetName, range) {
  const a1 = range ? `${sheetName}!${range}` : sheetName;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: a1 });
  return res.data.values || [];
}

function parsePerfRow(row) {
  return {
    date: row[0] || '',
    league: row[1] || '',
    market: row[2] || '',
    away: row[3] || '',
    home: row[4] || '',
    startTime: row[5] || '',
    betType: row[6] || '',
    pick: row[7] || '',
    line: row[8] || '',
    odds: parseFloat(row[9]) || -110,
    units: parseFloat(row[10]) || 0,
    confidence: row[11] || '',
    result: row[16] || '',
    unitReturn: parseFloat(row[17]) || 0,
  };
}

function parsePropRow(row) {
  return {
    timestamp: row[0] || '',
    league: row[1] || '',
    player: row[2] || '',
    market: row[3] || '',
    line: row[4] || '',
    direction: row[5] || '',
    book: row[6] || '',
    bookOdds: parseInt(row[7]) || -110,
    bookProb: parseFloat(row[8]) || 0,
    consensusProb: parseFloat(row[9]) || 0,
    edge: parseFloat(row[10]) || 0,
    game: row[11] || '',
    prizepicks: row[12] || '',
    underdog: row[13] || '',
    betr: row[14] || '',
    sleepr: row[15] || '',
  };
}

function parseOddsRow(row) {
  return {
    sport: row[1] || '',
    home: row[2] || '',
    away: row[3] || '',
    commence: row[4] || '',
    market: row[5] || '',
    outcome: row[6] || '',
    price: parseFloat(row[7]) || 0,
    point: row[8] || '',
    book: row[9] || '',
  };
}

export async function GET() {
  try {
    const sheets = await getSheetsClient();
    const sb = getSupabase();

    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const mm = today.getMonth() + 1;
    const dd = today.getDate();
    const yyyy = today.getFullYear();
    const todayStr = `${mm}/${dd}/${yyyy}`;
    const isoToday = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

    // Supabase queries for the MAIN load only (today's picks + odds snapshot).
    // Graded-history queries were moved to /api/results. Each resolves to null
    // on error so the Sheets fallbacks below still work.
    const sbTodayQ = sb
      ? sb.from('performance_log')
          .select('date, league, game, market, pick, line, odds, confidence, final_units, result')
          .eq('date', isoToday)
          .then(r => (r.error ? null : r.data)).catch(() => null)
      : Promise.resolve(null);

    const sbSnapQ = sb
      ? sb.from('sheet_snapshots')
          .select('rows').eq('entity', 'gameOdds')
          .order('captured_at', { ascending: false }).limit(1)
          .then(r => (r.error ? null : r.data)).catch(() => null)
      : Promise.resolve(null);

    const [perfRows, propRows, oddsRows, sbTodayRows, sbSnap] = await Promise.all([
      getValues(sheets, 'Performance Log', 'A1:S10000'),
      getValues(sheets, 'Prop_Combos', 'A1:P500'),
      getValues(sheets, 'Today_Odds', 'A1:J5000'),
      sbTodayQ,
      sbSnapQ,
    ]);

    const allPicks = perfRows.slice(1).map(parsePerfRow);

    // Today's picks: default to Sheets filter; prefer Supabase if it has rows.
    let todayPicks = allPicks.filter(p => p.date === todayStr);
    if (sbTodayRows && sbTodayRows.length > 0) {
      todayPicks = sbTodayRows.map(r => {
        const gp = (r.game || '').split(' @ ');
        return {
          date: todayStr, league: r.league || '', market: r.market || '',
          away: gp[0] || '', home: gp[1] || '', startTime: '', betType: r.market || '',
          pick: r.pick || '', line: r.line != null ? String(r.line) : '',
          odds: r.odds || -110, units: r.final_units || 0,
          confidence: r.confidence != null ? String(r.confidence) : '', result: r.result || '',
          unitReturn: 0,
        };
      });
    }

    // Parse props
    const props = propRows.slice(1).map(parsePropRow).filter(p => p.player);

    // Build unique games: prefer the gameOdds snapshot in Supabase, else Today_Odds.
    let oddsSource = oddsRows;
    if (sbSnap && sbSnap[0] && Array.isArray(sbSnap[0].rows) && sbSnap[0].rows.length > 1) {
      oddsSource = sbSnap[0].rows;
    }
    const gameMap = {};
    for (const row of oddsSource.slice(1)) {
      const o = parseOddsRow(row);
      const key = `${o.away}@${o.home}`;
      if (!gameMap[key]) {
        gameMap[key] = {
          league: o.sport,
          away: o.away,
          home: o.home,
          commence: o.commence,
        };
      }
    }
    const todayGames = Object.values(gameMap);

    return NextResponse.json({
      todayPicks,
      props,
      todayGames,
      lastUpdated: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    });
  } catch (err) {
    console.error('API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
