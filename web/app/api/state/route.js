import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Cross-device sync for "my bets" (which picks are taken/faded) and pick
// mode (build/watch). Single-user app, no auth — one row per day in
// `daily_state`; saves merge so locked bets are never lost (see POST). GET loads today's state on app open;
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

    // 2026-10-03: locked bets outlive the day they were placed (a bet locked at
    // 9 PM is for tomorrow's game). With no row for today yet, hand back the
    // most recent earlier day's entries; the client keeps only the locked ones.
    let carry;
    if (!data) {
      const prev = await sb.from('daily_state').select('my_bets')
        .lt('date', date).order('date', { ascending: false }).limit(1).maybeSingle();
      carry = prev.data?.my_bets || [];
    }

    return NextResponse.json({
      found: !!data,
      myBets: data?.my_bets || [],
      pickMode: data?.pick_mode || 'build',
      ...(carry ? { carry } : {}),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// A locked bet is { ..., locked: true }; see isLockedEntry() in page.js.
const isLocked = (v) => !!(v && typeof v === 'object' && v.locked);

export async function POST(req) {
  try {
    const body = await req.json();
    const { date, myBets, pickMode, unlocked } = body || {};
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });

    const sb = getSupabase();
    if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    // 2026-10-24: merge, don't overwrite. A locked bet already saved for this
    // day survives a save that doesn't include it — e.g. from a second device
    // still showing an older copy, or a slow request arriving after a newer
    // one — unless this save explicitly unlocked it. Before, last write won and
    // a stale device silently wiped bets locked on the other.
    const incoming = new Map(Array.isArray(myBets) ? myBets : []);
    const drop = new Set(Array.isArray(unlocked) ? unlocked : []);
    const { data: existing, error: readErr } = await sb.from('daily_state').select('my_bets').eq('date', date).maybeSingle();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const kept = [];
    for (const [k, v] of (existing?.my_bets || [])) {
      if (isLocked(v) && !drop.has(k) && !isLocked(incoming.get(k))) {
        incoming.set(k, v);
        kept.push([k, v]);
      }
    }

    const { error } = await sb.from('daily_state').upsert({
      date,
      my_bets: [...incoming.entries()],
      pick_mode: pickMode || 'build',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'date' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // `kept`: locks this device didn't have, so it can show them too.
    return NextResponse.json({ ok: true, kept }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
