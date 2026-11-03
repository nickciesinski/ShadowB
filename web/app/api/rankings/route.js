import { google } from 'googleapis';
import { NextResponse } from 'next/server';

// Player rankings for the Rankings tab. trigger18 (src/player-rankings.js)
// writes a "<LEAGUE> Rankings" sheet to the rankings spreadsheet every Tuesday;
// src/injury-impact.js turns each player's score into a tier, and the tier
// into how much an absence costs his team. This route reads the same sheet and
// applies the same rules, so the tab shows exactly what the model charges.
export const dynamic = 'force-dynamic';

const LEAGUES = ['NBA', 'NFL', 'NHL', 'MLB'];

// Mirrors src/injury-impact.js — keep in step if those change.
const TIER_SEVERITY = { S: 0.50, A: 0.35, B: 0.20, C: 0.10, D: 0.05 };
const STATUS_MULTIPLIER = {
  out: 1.0, o: 1.0, scratched: 1.0, suspended: 1.0, doubtful: 0.75, d: 0.75,
  questionable: 0.40, q: 0.40, 'day-to-day': 0.30, dtd: 0.30, probable: 0.10, p: 0.10,
};
const LONG_TERM = new Set(['injured reserve', 'ir', '60-day-il', 'suspension', 'suspended']);

function tierFromRating(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 85) return 'S';
  if (score >= 68) return 'A';
  if (score >= 50) return 'B';
  if (score >= 32) return 'C';
  return 'D';
}

// What this player's current status costs his team in the model, or null if
// he is healthy. Long-term absences are already in the season stats, so 0.
function injuryCost(tier, status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === 'active' || s === 'healthy' || s === 'available') return null;
  if (LONG_TERM.has(s)) return 0;
  return (TIER_SEVERITY[tier] || TIER_SEVERITY.C) * (STATUS_MULTIPLIER[s] ?? 0.5);
}

export async function GET(req) {
  const league = (new URL(req.url).searchParams.get('league') || 'NBA').toUpperCase();
  if (!LEAGUES.includes(league)) {
    return NextResponse.json({ ok: false, error: `Unknown league ${league}` }, { status: 400 });
  }
  const sheetId = process.env.RANKINGS_SPREADSHEET_ID;
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sheetId || !sa) {
    return NextResponse.json({
      ok: false,
      error: !sheetId ? 'RANKINGS_SPREADSHEET_ID is not set in Vercel' : 'GOOGLE_SERVICE_ACCOUNT_JSON is not set in Vercel',
    }, { status: 503 });
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(sa),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${league} Rankings` });
    const rows = (res.data.values || []).slice(1);

    // Summary schema: Name, Team, Position, Group, Composite, Tier, Rank,
    // Injury Status, Frozen Score, Frozen Rank, Age, Last Updated
    let updated = '';
    const players = [];
    for (const r of rows) {
      const name = (r[0] || '').trim();
      const score = parseFloat(r[4]);
      if (!name || !Number.isFinite(score)) continue;
      const tier = tierFromRating(score);
      const status = (r[7] || '').trim();
      players.push({
        name,
        team: (r[1] || '').trim().toUpperCase(),
        pos: (r[2] || '').trim(),
        group: (r[3] || '').trim(),
        score: Math.round(score * 10) / 10,
        tier,
        status,
        cost: injuryCost(tier, status),
      });
      if (r[11] && r[11] > updated) updated = r[11];
    }
    players.sort((a, b) => b.score - a.score);

    return NextResponse.json(
      { ok: true, league, updated, players },
      { headers: { 'Cache-Control': 's-maxage=300, stale-while-revalidate=3600' } },
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
