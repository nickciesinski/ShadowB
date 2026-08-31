'use strict';
// =============================================================
// scripts/venue-compare.js
//
// "Would we be profitable somewhere else?" answered numerically.
//
// For every clean ticket, swap the sportsbook hold we actually paid for the
// fee each venue would have charged, and re-run net edge. The substitution is
// exact in units: vig_paid_pp is a probability overcharge and an exchange fee
// on a $1 contract is already in probability points.
//
// LOAD-BEARING ASSUMPTION: that the exchange quotes the same fair line as the
// book consensus. If an exchange runs a wider spread, the fee saving is eaten
// by a worse price and these numbers are optimistic. Only live fills settle
// that - this script sizes the prize, it does not prove it.
//
// Usage: node scripts/venue-compare.js [--rule-c] [--league MLB]
// =============================================================

const { venueCost } = require('../src/venue-cost');
const db = require('../src/db');

const VENUES = [
  ['sportsbook', null], ['kalshi', 'taker'], ['kalshi', 'maker'],
  ['novig', 'taker'], ['novig', 'maker'],
];

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function pp(v) { return v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(3)}pp`; }

async function main() {
  const args = process.argv.slice(2);
  const ruleCOnly = args.includes('--rule-c');
  const li = args.indexOf('--league');
  const league = li >= 0 ? args[li + 1] : null;

  if (!db.isEnabled()) { console.error('[venue-compare] Supabase required.'); process.exit(1); }
  const sb = db.getClient();
  let q = sb.from('performance_log')
    .select('league, market, clv_prob_delta, vig_paid_pp, placed_novig_prob, rule_c_eligible, tradeable')
    .eq('pick_regime', 'v2_clv').eq('clv_basis', 'novig').lte('close_lag_hours', 6)
    .like('model_version', 'v2.3%').limit(5000);
  if (league) q = q.eq('league', league);
  const { data, error } = await q;
  if (error) { console.error('[venue-compare]', error.message); process.exit(1); }

  const rows = (data || []).filter(r =>
    r.tradeable !== false &&
    r.clv_prob_delta != null && r.vig_paid_pp != null && r.placed_novig_prob != null &&
    (!ruleCOnly || r.rule_c_eligible === true));

  if (!rows.length) { console.log('[venue-compare] no qualifying rows'); return; }

  console.log(`\n# Venue comparison — ${rows.length} tickets`
    + `${league ? ` · ${league}` : ''}${ruleCOnly ? ' · rule C only' : ''}\n`);
  console.log('| Venue | Cost | Net edge | t |');
  console.log('|---|---|---|---|');

  for (const [venue, role] of VENUES) {
    const costs = [], edges = [];
    for (const r of rows) {
      const cost = venue === 'sportsbook'
        ? Number(r.vig_paid_pp)
        : venueCost(venue, Number(r.placed_novig_prob), role);
      if (cost == null || !Number.isFinite(cost)) continue;
      costs.push(cost);
      edges.push(Number(r.clv_prob_delta) - cost);
    }
    if (!edges.length) { console.log(`| ${venue}${role ? ' ' + role : ''} | — | not modelled | — |`); continue; }
    const m = mean(edges), s = sd(edges);
    const t = (s && s > 0) ? (m / s) * Math.sqrt(edges.length) : null;
    const label = venue === 'sportsbook' ? 'Sportsbook (measured)' : `${venue} ${role}`;
    console.log(`| ${label} | ${pp(mean(costs))} | ${pp(m)} | ${t == null ? '—' : t.toFixed(2)} |`);
  }
  console.log('\nCost is the probability overcharge paid to get on. Net edge = CLV − cost.');
  console.log('Assumes each venue quotes the same fair line as the book consensus — unverified.');
  console.log('Venues with no confirmed fee schedule are reported as "not modelled", never as free.\n');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
