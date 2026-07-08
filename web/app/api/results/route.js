import { google } from 'googleapis';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Deferred / lazy-loaded endpoint: graded history (Results tab).
// Split out of /api/data so the main load (Picks/Scores) doesn't pay for the
// full-history Supabase queries or ship that large payload. The client fetches
// this AFTER the main data has loaded.
//
// `force-dynamic` keeps it running per-request (no build-time prerender);
// edge caching is handled by the Cache-Control header on the response below.
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

// Sheets-fallback parser for graded picks (same layout as /api/data).
function parsePerfRow(row) {
  return {
    date: row[0] || '', league: row[1] || '', market: row[2] || '',
    away: row[3] || '', home: row[4] || '', startTime: row[5] || '',
    betType: row[6] || '', pick: row[7] || '', line: row[8] || '',
    odds: parseFloat(row[9]) || -110, units: parseFloat(row[10]) || 0,
    confidence: row[11] || '', result: row[16] || '', unitReturn: parseFloat(row[17]) || 0,
  };
}

export async function GET() {
  try {
    const sb = getSupabase();

    // Both full-history queries run in parallel.
    const sbGradedQ = sb
      ? sb.from('performance_log')
          .select('date, league, game, market, pick, line, odds, confidence, final_units, result')
          .in('result', ['W', 'L', 'P'])
          .order('date', { ascending: false })
          .then(r => (r.error ? null : r.data)).catch(() => null)
      : Promise.resolve(null);

    const sbPropsQ = sb
      ? sb.from('prop_performance')
          .select('date, league, player, market, line, direction, book, opening_edge, closing_edge, clv_grade, units, actual_result')
          .in('actual_result', ['W', 'L'])
          .order('date', { ascending: false })
          .then(r => (r.error ? null : r.data)).catch(() => null)
      : Promise.resolve(null);

    const [sbGradedRows, sbPropRows] = await Promise.all([sbGradedQ, sbPropsQ]);

    // Graded picks: prefer Supabase; only touch Sheets if Supabase is empty.
    let gradedPicks = [];
    if (sbGradedRows && sbGradedRows.length > 0) {
      gradedPicks = sbGradedRows.map(r => {
        const gameParts = (r.game || '').split(' @ ');
        let dateStr = r.date || '';
        if (dateStr.includes('-')) {
          const [y, m, d] = dateStr.split('-');
          dateStr = `${parseInt(m)}/${parseInt(d)}/${y}`;
        }
        return {
          date: dateStr, league: r.league || '', market: r.market || '',
          away: gameParts[0] || '', home: gameParts[1] || '',
          betType: r.market || '', pick: r.pick || '',
          line: r.line != null ? String(r.line) : '',
          odds: r.odds || -110, units: r.final_units || 0,
          confidence: r.confidence != null ? String(r.confidence) : '',
          result: r.result || '',
          unitReturn: r.result === 'W' ? (r.odds > 0 ? (r.final_units * r.odds / 100) : (r.final_units * 100 / Math.abs(r.odds))) : r.result === 'L' ? -(r.final_units || 0) : 0,
        };
      });
    }
    if (gradedPicks.length === 0) {
      // Sheets fallback (only runs when Supabase returned nothing).
      const sheets = await getSheetsClient();
      const perfRows = await getValues(sheets, 'Performance Log', 'A1:S10000');
      gradedPicks = perfRows.slice(1).map(parsePerfRow).filter(p => p.result === 'W' || p.result === 'L' || p.result === 'P');
    }

    // Graded props (Supabase only).
    let gradedProps = [];
    if (sbPropRows && sbPropRows.length > 0) {
      gradedProps = sbPropRows.map(r => {
        let dateStr = r.date || '';
        if (dateStr.includes('-')) {
          const [y, m, d] = dateStr.split('-');
          dateStr = `${parseInt(m)}/${parseInt(d)}/${y}`;
        }
        const u = r.units || 0;
        return {
          date: dateStr, league: r.league || '', player: r.player || '',
          market: r.market || '', line: r.line != null ? String(r.line) : '',
          direction: r.direction || '', book: r.book || '',
          edge: r.closing_edge || r.opening_edge || 0, clvGrade: r.clv_grade || '',
          units: u, result: r.actual_result || '',
          unitReturn: r.actual_result === 'W' ? u : -(u),
        };
      });
    }

    return NextResponse.json({
      gradedPicks, gradedProps, lastUpdated: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    });
  } catch (err) {
    console.error('Results API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
