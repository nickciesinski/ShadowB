import { google } from 'googleapis';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Novig / prediction-market ceiling, in cents. Mirrors novigMaxCents() in
// scripts/evening-digest.js — the price is the book's own improved by 10
// American cents, converted to cents and rounded DOWN. Rounding up would quote
// a worse price than intended, which hands the sportsbook's cut back.
function novigMaxCents(americanOdds) {
  const n = Number(americanOdds);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  const improved = n + 10;
  const implied = improved > 0 ? 100 / (improved + 100) : -improved / (-improved + 100);
  const cents = Math.floor(implied * 100);
  return (cents > 0 && cents < 100) ? cents : null;
}
// 2026-08-31 — the app shows CALIBRATED confidence/edge/units, not the model's
// raw output. The raw numbers claimed an average +13pp edge against a measured
// +0.2pp, with 78% of picks at 10/10; that display is why the results kept
// looking better than they were. Bundled by web/scripts/copy-params.mjs.
import { displayFor } from './_shared/calibrated-display.mjs';

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
  // Next.js's App Router patches global fetch() to cache requests by default —
  // this applies to ANY fetch call made inside a route handler, including the
  // ones supabase-js makes internally, independently of this route's own
  // `dynamic = 'force-dynamic'` (which only governs the route's own response,
  // not nested fetches). Without this override, the first successful Supabase
  // query gets cached indefinitely and every later request — even after a
  // redeploy — keeps getting served that stale snapshot.
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    global: { fetch: (url, options) => fetch(url, { ...options, cache: 'no-store' }) },
  });
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
    // 2026-08-26: soccer now locks in picks up to a week ahead (CLV strategy —
    // see ShadowB-Soccer's lookaheadDays), and those rows already sit in the
    // shared table today. Widen the window so the app's Today/Tomorrow/This Week
    // picker on the Picks tab has something to show, not just isoToday.
    // 2026-09-12: reach BACK two days as well. A Novig maker order placed at
    // 9 PM is still unsettled the next morning, and once the date flipped those
    // picks left the payload entirely — so an order that never filled could
    // never be marked "no fill". The unfilled orders are half the venue
    // measurement (the 2026-09-11 pilot's 44% CLV-capture figure is only
    // computable because the misses were recorded), so losing them silently
    // would have quietly broken the test rather than the app.
    const twoDaysAgo = new Date(today); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const isoTwoDaysAgo = `${twoDaysAgo.getFullYear()}-${String(twoDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(twoDaysAgo.getDate()).padStart(2, '0')}`;
    const weekAhead = new Date(today); weekAhead.setDate(weekAhead.getDate() + 7);
    const isoWeekAhead = `${weekAhead.getFullYear()}-${String(weekAhead.getMonth() + 1).padStart(2, '0')}-${String(weekAhead.getDate()).padStart(2, '0')}`;

    // Supabase queries for the MAIN load only (today-through-next-week picks +
    // odds snapshot). Graded-history queries were moved to /api/results. Each
    // resolves to null on error so the Sheets fallbacks below still work.
    const sbTodayQ = sb
      ? sb.from('performance_log')
          .select('date, league, game, start_time, market, pick, line, odds, confidence, final_units, result, selection, alt_prices, calibrated_prob, best_odds, rule_c_eligible, pick_id')
          .gte('date', isoTwoDaysAgo).lte('date', isoWeekAhead)
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

    // Today's picks: default to Sheets filter (today only); prefer Supabase if it
    // has rows (now today-through-next-week — each row keeps its OWN date rather
    // than being stamped "today", so the app's date picker can tell them apart).
    let todayPicks = allPicks.filter(p => p.date === todayStr).map(p => ({ ...p, isoDate: isoToday }));
    if (sbTodayRows && sbTodayRows.length > 0) {
      todayPicks = sbTodayRows.map(r => {
        const gp = (r.game || '').split(' @ ');
        const rowIso = r.date || isoToday;
        const [ry, rm2, rd2] = rowIso.split('-');
        const rowDateStr = `${parseInt(rm2)}/${parseInt(rd2)}/${ry}`;
        return {
          date: rowDateStr, isoDate: rowIso, league: r.league || '', market: r.market || '',
          away: gp[0] || '', home: gp[1] || '', startTime: r.start_time || '', betType: r.market || '',
          pick: r.pick || '', line: r.line != null ? String(r.line) : '',
          odds: r.odds || -110,
          // Novig ceiling, in cents. Novig is a prediction market: contracts
          // trade 0-100c and pay $1, so 41c is +140 and American odds are
          // unusable there. Null on anything but a rule-C pick, which the UI
          // renders as a dash — the other picks need a ~79% cut in hold to
          // break even, where rule C needs ~37%, so pricing them would point
          // at bets that lose even at zero fees. Same helper as the evening
          // digest so the app and the email can never quote different numbers.
          novigMaxCents: r.rule_c_eligible === true ? novigMaxCents(r.best_odds ?? r.odds) : null,
          // Join key for the Novig order log (/api/novig). Without it the app
          // can display a price but cannot record whether the order filled,
          // and the unfilled orders are the half of the measurement that makes
          // the fill rate mean anything.
          pickId: r.pick_id || null,
          // Calibrated display. `edge` is expected return per unit staked at the
          // best price we could take; confidence scales on that real edge rather
          // than on rank, so most picks sit at 1 and the rare good one stands
          // out. A league with no fitted map (EPL today) reports calibrated:false
          // and keeps its raw figures rather than showing them as calibrated.
          ...(() => {
            const d = displayFor(r);
            return d.calibrated
              ? { units: d.units, confidence: String(d.confidence),
                  edgePp: Math.round(d.edge * 1000) / 10, calibrated: true }
              : { units: r.final_units || 0,
                  confidence: r.confidence != null ? String(r.confidence) : '',
                  edgePp: null, calibrated: false };
          })(),
          result: r.result || '',
          unitReturn: 0,
          // 3-way (soccer) side selection: `selection` is which of home/draw/away the
          // model took, `altPrices` the American price for all three. Null on US-sports
          // rows and on any soccer row written before the 2026-08-28 migration — the
          // app treats absent prices as "side unavailable", never as a number to guess.
          selection: r.selection || '', altPrices: r.alt_prices || null,
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
