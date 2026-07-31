// Phase 3 — closing-line-value lifecycle.
//   rollLastSeen()        : update last_seen line/odds on open v2 tickets from the
//                           freshest gameOdds snapshot (line movement between lock and close).
//   freezeClosedTickets() : once a game has started, freeze close_* := last_seen_*,
//                           compute CLV, and mark the ticket 'closed'. No API cost.
const db = require('./db');
const { americanToImpliedProb } = require('./market-pricing');

// performance_log market names -> odds-feed market keys
const MARKET_MAP = { moneyline: 'h2h', spread: 'spreads', total: 'totals' };

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The odds-feed outcome label for a ticket's side.
function sideOutcome(market, pick) {
  if (market === 'total') return /over/i.test(pick || '') ? 'Over' : 'Under';
  return pick; // moneyline/spread: outcome is the team name
}

// Roll last_seen on every open v2 ticket from the freshest gameOdds snapshot.
async function rollLastSeen() {
  const sb = db.getClient();
  if (!sb) return { updated: 0, reason: 'no_db' };

  const { data: snap } = await sb.from('sheet_snapshots')
    .select('rows, captured_at').eq('entity', 'gameOdds')
    .order('captured_at', { ascending: false }).limit(1);
  const rows = snap && snap[0] && Array.isArray(snap[0].rows) ? snap[0].rows : null;
  if (!rows || rows.length < 2) return { updated: 0, reason: 'no_snapshot' };
  // last_seen_at = when the odds were actually captured (not now), so
  // close_lag_hours honestly reflects how stale the closing price is. This is
  // why the near-kickoff odds pull matters — it's what shrinks that lag.
  const capturedAt = snap[0].captured_at || new Date().toISOString();

  // "eventId|market|outcome" -> { prices:[...], point }
  const priceMap = {};
  for (const r of rows.slice(1)) {
    const eventId = r[10], market = r[5], outcome = r[6];
    const price = parseFloat(r[7]), point = r[8];
    if (!eventId) continue;
    const k = `${eventId}|${market}|${outcome}`;
    if (!priceMap[k]) priceMap[k] = { prices: [], point };
    if (Number.isFinite(price)) priceMap[k].prices.push(price);
  }

  const { data: tickets } = await sb.from('performance_log')
    .select('pick_id, event_id, market, pick, line')
    .eq('pick_regime', 'v2_clv').eq('status', 'open');
  if (!tickets || !tickets.length) return { updated: 0, reason: 'no_open_tickets' };

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const t of tickets) {
    if (!t.event_id) continue;
    const oddsMarket = MARKET_MAP[t.market] || t.market;
    const outcome = sideOutcome(t.market, t.pick);
    const entry = priceMap[`${t.event_id}|${oddsMarket}|${outcome}`];
    if (!entry || !entry.prices.length) continue;
    const point = entry.point !== '' && entry.point != null ? parseFloat(entry.point) : t.line;
    const { error } = await sb.from('performance_log')
      .update({ last_seen_odds: Math.round(median(entry.prices)), last_seen_line: point, last_seen_at: capturedAt })
      .eq('pick_id', t.pick_id);
    if (!error) updated++;
  }
  return { updated, open: tickets.length };
}

// Freeze open tickets whose game has started; compute CLV from open vs close.
async function freezeClosedTickets() {
  const sb = db.getClient();
  if (!sb) return { frozen: 0, reason: 'no_db' };

  const nowIso = new Date().toISOString();
  const { data: tickets } = await sb.from('performance_log')
    .select('pick_id, open_odds, open_line, last_seen_odds, last_seen_line, last_seen_at, commence_time')
    .eq('pick_regime', 'v2_clv').eq('status', 'open')
    .lte('commence_time', nowIso);
  if (!tickets || !tickets.length) return { frozen: 0 };

  let frozen = 0;
  for (const t of tickets) {
    const closeOdds = t.last_seen_odds != null ? t.last_seen_odds : t.open_odds;
    const closeLine = t.last_seen_line != null ? t.last_seen_line : t.open_line;
    const openImplied = t.open_odds != null ? americanToImpliedProb(t.open_odds) : null;
    const closeImplied = closeOdds != null ? americanToImpliedProb(closeOdds) : null;
    // "Beat the close" = your locked price implied a LOWER probability than the
    // close (you got a longer/better price). Positive delta = positive CLV.
    const clvProbDelta = (openImplied != null && closeImplied != null)
      ? Math.round((closeImplied - openImplied) * 1e4) / 1e4 : null;
    const clvLineDelta = (t.open_line != null && closeLine != null)
      ? Math.round((closeLine - t.open_line) * 100) / 100 : null;
    const beatClose = clvProbDelta != null ? clvProbDelta > 0 : null;
    const lagHours = (t.last_seen_at && t.commence_time)
      ? Math.round(((new Date(t.commence_time).getTime() - new Date(t.last_seen_at).getTime()) / 3.6e6) * 10) / 10
      : null;

    const { error } = await sb.from('performance_log').update({
      close_odds: closeOdds,
      close_line: closeLine,
      close_captured_at: t.last_seen_at || nowIso,
      close_lag_hours: lagHours,
      clv_prob_delta: clvProbDelta,
      clv_line_delta: clvLineDelta,
      clv_beat_close: beatClose,
      close_source: 'last_seen',
      status: 'closed',
    }).eq('pick_id', t.pick_id);
    if (!error) frozen++;
  }
  return { frozen };
}

module.exports = { rollLastSeen, freezeClosedTickets };
