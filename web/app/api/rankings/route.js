import { google } from 'googleapis';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Player rankings for the Rankings tab. trigger18 (src/player-rankings.js)
// writes a "<LEAGUE> Rankings" sheet every Tuesday. For each injured starter
// this route also finds his replacement and the impact (rating gap), using
// src/injury-replacement.js — the same code the model runs.
export const dynamic = 'force-dynamic';

const LEAGUES = ['NBA', 'NFL', 'NHL', 'MLB'];

// Same code the model uses (copied from src/ at build by copy-params.mjs).
import replacement from './_shared/injury-replacement.js';
const { computeReplacementImpact } = replacement;

function tierFromRating(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 85) return 'S';
  if (score >= 68) return 'A';
  if (score >= 50) return 'B';
  if (score >= 32) return 'C';
  return 'D';
}

const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();

// Today's injury report (the rankings sheet's own column is a weekly snapshot).
async function latestInjuries(league) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const sb = createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: 'no-store' }) },
  });
  const { data: last } = await sb.from('daily_injuries').select('date')
    .eq('league', league).order('date', { ascending: false }).limit(1);
  const date = last?.[0]?.date;
  if (!date) return null;
  const { data } = await sb.from('daily_injuries').select('player, status')
    .eq('league', league).eq('date', date).limit(5000);
  const map = {};
  for (const r of data || []) map[norm(r.player)] = r.status || '';
  return { date, map };
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
    let inj = null;
    try { inj = await latestInjuries(league); } catch (e) { inj = null; }
    let updated = '';
    const base = [];
    for (const r of rows) {
      const name = (r[0] || '').trim();
      const score = parseFloat(r[4]); // same column the model reads
      if (!name || !Number.isFinite(score)) continue;
      const status = inj ? (inj.map[norm(name)] || '') : (r[7] || '').trim();
      base.push({
        name, team: (r[1] || '').trim().toUpperCase(), pos: (r[2] || '').trim(),
        group: (r[3] || '').trim(), score: Math.round(score * 10) / 10, status,
      });
      if (r[11] && r[11] > updated) updated = r[11];
    }
    const { players: scored, teams } = computeReplacementImpact(league, base);
    const players = scored.map(p => ({
      name: p.name, team: p.team, pos: p.pos, group: p.group, score: p.score,
      tier: tierFromRating(p.score), status: p.status, starter: p.starter,
      replacement: p.replacement, replacementScore: p.replacementScore,
      impact: p.status ? Math.round(p.impact * 100) / 100 : null,
    })).sort((a, b) => b.score - a.score);

    return NextResponse.json(
      { ok: true, league, updated, injuriesAsOf: inj?.date || null, players, teams },
      { headers: { 'Cache-Control': 's-maxage=300, stale-while-revalidate=3600' } },
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
