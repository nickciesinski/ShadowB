import { google } from 'googleapis';
import { NextResponse } from 'next/server';

// Force dynamic — never cache this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

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

    // Fetch in parallel
    const [perfRows, propRows, oddsRows] = await Promise.all([
      getValues(sheets, 'Performance Log', 'A1:S500'),
      getValues(sheets, 'Prop_Combos', 'A1:P500'),
      getValues(sheets, 'Today_Odds', 'A1:J5000'),
    ]);

    // Parse Performance Log (use PST/PDT to match sheet dates)
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const mm = today.getMonth() + 1;
    const dd = today.getDate();
    const yyyy = today.getFullYear();
    const todayStr = `${mm}/${dd}/${yyyy}`;

    const allPicks = perfRows.slice(1).map(parsePerfRow);
    const todayPicks = allPicks.filter(p => p.date === todayStr);
    const gradedPicks = allPicks.filter(p => p.result === 'W' || p.result === 'L' || p.result === 'P');

    // Parse props
    const props = propRows.slice(1).map(parsePropRow).filter(p => p.player);

    // Build unique games from today's odds
    const gameMap = {};
    for (const row of oddsRows.slice(1)) {
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
      gradedPicks: gradedPicks.slice(0, 200),
      props,
      todayGames,
      lastUpdated: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
    });
  } catch (err) {
    console.error('API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
