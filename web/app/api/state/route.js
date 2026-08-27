import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Cross-device sync for "my bets" (which picks are taken/faded) and pick
// mode (build/watch). Single-user app, no auth — one row per day in
// `daily_state`, last write wins. GET loads today's state on app open;
// POST is fired on every myBets/pickMode change so any device is always
// current within a request round-trip.
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  // See /api/data/route.js — Next.js caches fetch() inside route handlers by
  // default, independent of `dynamic = 'force-dynamic'`. Without this, every
  // device would keep reading back whatever state was cached on first load.
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    global: { fetch: (url, options) => fetch(url, { ...options, cache: 'no-store' }) },
  });
}

export async function GET(req) {
  try {
    const date = new URL(req.url).searchParams.get('date');
    if (!date) return NextResponse.json({ error: 'date query param required' }, { status: 400 });

    const sb = getSupabase();
    if (!sb) return NextResponse.json({ found: false, myBets: [], pickMode: 'build' }, { headers: { 'Cache-Control': 'no-store' } });

    const { data, error } = await sb.from('daily_state').select('my_bets, pick_mode').eq('date', date).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      found: !!data,
      myBets: data?.my_bets || [],
      pickMode: data?.pick_mode || 'build',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { date, myBets, pickMode } = body || {};
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });

    const sb = getSupabase();
    if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const { error } = await sb.from('daily_state').upsert({
      date,
      my_bets: Array.isArray(myBets) ? myBets : [],
      pick_mode: pickMode || 'build',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'date' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
