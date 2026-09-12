import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Novig maker-order log — which orders were posted, and which of them filled.
//
// 2026-09-12. This is the measurement layer for the venue test, not UI state,
// which is why it does not live in daily_state. THE UNFILLED ROWS ARE THE
// POINT: on 2026-09-11, four of eight orders filled and those four captured
// only 44% of the CLV on offer (0.72pp against 2.54pp on the misses). That
// number is only computable because the misses were recorded. A log of fills
// alone is survivorship-biased and answers the wrong question.
//
// Rows are keyed by pick_id and updated in place, so re-marking an order is
// idempotent and a device re-syncing cannot wipe another device's entries —
// unlike daily_state, which is a whole-day last-write-wins blob.
export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  // Same cache defeat as /api/state — Next caches fetch() inside route
  // handlers regardless of `dynamic`, which would serve a stale order log.
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    global: { fetch: (url, options) => fetch(url, { ...options, cache: 'no-store' }) },
  });
}

const STATES = new Set(['ordered', 'filled', 'unfilled']);
const noStore = { 'Cache-Control': 'no-store' };

export async function GET(req) {
  try {
    const date = new URL(req.url).searchParams.get('date');
    const sb = getSupabase();
    if (!sb) return NextResponse.json({ orders: {} }, { headers: noStore });

    let q = sb.from('novig_orders').select('pick_id, posted_cents, state, fill_cents, game_date');
    if (date) q = q.eq('game_date', date);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Keyed by pick_id so the client can look up a row without scanning.
    const orders = {};
    for (const r of data || []) orders[r.pick_id] = r;
    return NextResponse.json({ orders }, { headers: noStore });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { pickId, gameDate, postedCents, state, fillCents } = body || {};
    if (!pickId) return NextResponse.json({ error: 'pickId required' }, { status: 400 });
    if (state && !STATES.has(state)) {
      return NextResponse.json({ error: `state must be one of ${[...STATES].join(', ')}` }, { status: 400 });
    }

    const sb = getSupabase();
    if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    // A null state clears the row — the undo path for a mis-tap. Deleting
    // rather than writing a fourth "none" state keeps "every row is a real
    // posted order" true, which is what makes the fill rate meaningful.
    if (state === null) {
      const { error } = await sb.from('novig_orders').delete().eq('pick_id', pickId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, cleared: true }, { headers: noStore });
    }

    const row = {
      pick_id: pickId,
      game_date: gameDate,
      posted_cents: postedCents,
      state: state || 'ordered',
      updated_at: new Date().toISOString(),
    };
    if (Number.isFinite(fillCents)) row.fill_cents = fillCents;
    if (state === 'filled' || state === 'unfilled') row.settled_at = new Date().toISOString();

    const { error } = await sb.from('novig_orders')
      .upsert(row, { onConflict: 'pick_id' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
