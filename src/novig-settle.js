'use strict';
// =============================================================
// src/novig-settle.js — close out Novig orders Nick never came back to
//
// 2026-09-12. Novig does not push a fill notification: checking means opening
// the app. That friction is not merely annoying, it BIASES the result. A fill
// is satisfying to record and a miss is not, so manual marking systematically
// under-records misses — and the misses are the half that makes the fill rate
// mean anything. On 2026-09-11 the finding that fills captured only 44% of the
// CLV on offer is computable solely because the four misses were recorded. Lose
// those and the test reports a flattering number and nobody can tell.
//
// So the burden is inverted. Nick marks ONLY what filled. Anything still sitting
// at 'ordered' once the game has started and the grace period has passed is
// settled to 'unfilled' automatically, because his posting rule cancels the
// order ~60 minutes before start — an order that was never marked filled by
// then was, in fact, not filled.
//
// THE GRACE PERIOD EXISTS SO THE ERROR RUNS THE SAFE WAY. If he checks Novig
// the morning after, an aggressive auto-settle would mark real fills as misses.
// Six hours past first pitch clears every same-night check. And when it does
// get one wrong, it records a fill as a miss — which UNDERSTATES the fill rate
// and the edge. Between two biases, take the pessimistic one: it cannot talk us
// into staking money.
//
// Tapping F in the app after an auto-settle still corrects the row, so nothing
// here is final.
// =============================================================

const db = require('./db');

// Hours after first pitch before an unmarked order is presumed unfilled.
const GRACE_HOURS = 6;

/**
 * Settle stale 'ordered' rows.
 *
 * @param {object} opts { now, graceHours, dryRun }
 * @returns {Promise<{settled:number, skipped:number, reason?:string}>}
 */
async function settleStaleNovigOrders(opts = {}) {
  const sb = db.getClient();
  if (!sb) return { settled: 0, skipped: 0, reason: 'supabase_not_configured' };

  const now = opts.now ? new Date(opts.now) : new Date();
  const graceHours = opts.graceHours ?? GRACE_HOURS;
  const cutoff = new Date(now.getTime() - graceHours * 3600000).toISOString();

  const { data: open, error } = await sb
    .from('novig_orders')
    .select('pick_id, game_date, ordered_at, state')
    .eq('state', 'ordered');
  if (error) {
    console.warn('[novig-settle]', error.message);
    return { settled: 0, skipped: 0, reason: error.message };
  }
  if (!open || !open.length) return { settled: 0, skipped: 0 };

  // Join to the ledger for commence_time — the order log deliberately does not
  // duplicate it, so there is one source of truth for when a game started.
  const ids = open.map((o) => o.pick_id);
  const { data: picks, error: e2 } = await sb
    .from('performance_log')
    .select('pick_id, commence_time, game')
    .in('pick_id', ids);
  if (e2) {
    console.warn('[novig-settle]', e2.message);
    return { settled: 0, skipped: 0, reason: e2.message };
  }
  const startOf = new Map((picks || []).map((p) => [p.pick_id, p.commence_time]));

  const stale = open.filter((o) => {
    const start = startOf.get(o.pick_id);
    // No commence_time means we cannot prove the game has started. Leave it
    // open rather than guess — an order wrongly settled is a lost observation.
    if (!start) return false;
    return String(start) < cutoff;
  });

  if (!stale.length) return { settled: 0, skipped: open.length };
  if (opts.dryRun) return { settled: stale.length, skipped: open.length - stale.length, dryRun: true };

  const nowIso = now.toISOString();
  let settled = 0;
  for (const o of stale) {
    const { error: e3 } = await sb.from('novig_orders')
      .update({ state: 'unfilled', settled_at: nowIso, updated_at: nowIso })
      .eq('pick_id', o.pick_id)
      .eq('state', 'ordered'); // do not clobber a fill marked since the read
    if (e3) console.warn('[novig-settle]', o.pick_id, e3.message);
    else settled += 1;
  }
  console.log(`[novig-settle] settled ${settled} stale order(s) as unfilled; `
    + `${open.length - stale.length} still open`);
  return { settled, skipped: open.length - stale.length };
}

module.exports = { settleStaleNovigOrders, GRACE_HOURS };
