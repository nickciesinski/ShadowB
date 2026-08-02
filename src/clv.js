// Phase 3 — closing-line-value lifecycle.
//   rollLastSeen()        : update last_seen line/odds on open v2 tickets from the
//                           freshest gameOdds snapshot (line movement between lock and close).
//   freezeClosedTickets() : once a game has started, freeze close_* := last_seen_*,
//                           compute CLV, and mark the ticket 'closed'. No API cost.
const db = require('./db');
const { americanToImpliedProb, removeVig } = require('./market-pricing');
const { norm } = require('./norm');

// ESPN scoreboard path per league (free, no key, no rate limit).
const ESPN_PATH = {
  MLB: 'baseball/mlb', NBA: 'basketball/nba', NHL: 'hockey/nhl',
  NFL: 'football/nfl', EPL: 'soccer/eng.1',
};

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

// The odds-feed outcome label for the OTHER side of the same market. Needed to
// de-vig the close: a single side's implied price carries the full 4-5% hold,
// so a raw implied-to-implied delta measures the book's margin as much as the
// line move. removeVig() needs both outcomes.
function oppositeOutcome(market, pick, awayTeam, homeTeam) {
  if (market === 'total') return /over/i.test(pick || '') ? 'Under' : 'Over';
  if (!awayTeam || !homeTeam) return null;
  const p = norm(pick), a = norm(awayTeam), h = norm(homeTeam);
  if (p && h && (p === h || p.includes(h) || h.includes(p))) return awayTeam;
  if (p && a && (p === a || p.includes(a) || a.includes(p))) return homeTeam;
  return null;
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
    .select('pick_id, event_id, market, pick, line, away_team, home_team')
    .eq('pick_regime', 'v2_clv').eq('status', 'open');
  if (!tickets || !tickets.length) return { updated: 0, reason: 'no_open_tickets' };

  const nowIso = new Date().toISOString();
  let updated = 0, withOpp = 0;
  for (const t of tickets) {
    if (!t.event_id) continue;
    const oddsMarket = MARKET_MAP[t.market] || t.market;
    const outcome = sideOutcome(t.market, t.pick);
    const entry = priceMap[`${t.event_id}|${oddsMarket}|${outcome}`];
    if (!entry || !entry.prices.length) continue;
    const point = entry.point !== '' && entry.point != null ? parseFloat(entry.point) : t.line;

    // Opposite side, same event + market, from the same snapshot — free, and
    // it's what lets freeze compute a de-vigged close.
    const oppName = oppositeOutcome(t.market, t.pick, t.away_team, t.home_team);
    const oppEntry = oppName ? priceMap[`${t.event_id}|${oddsMarket}|${oppName}`] : null;
    const oppOdds = (oppEntry && oppEntry.prices.length) ? Math.round(median(oppEntry.prices)) : null;
    if (oppOdds != null) withOpp++;

    const patch = { last_seen_odds: Math.round(median(entry.prices)), last_seen_line: point, last_seen_at: capturedAt };
    if (oppOdds != null) patch.last_seen_opp_odds = oppOdds;
    const { error } = await sb.from('performance_log')
      .update(patch)
      .eq('pick_id', t.pick_id);
    if (!error) updated++;
  }
  return { updated, open: tickets.length, withOpp };
}

// Freeze open tickets whose game has started; compute CLV from open vs close.
async function freezeClosedTickets() {
  const sb = db.getClient();
  if (!sb) return { frozen: 0, reason: 'no_db' };

  const nowIso = new Date().toISOString();
  const { data: tickets } = await sb.from('performance_log')
    .select('pick_id, open_odds, open_line, placed_novig_prob, last_seen_odds, last_seen_line, last_seen_opp_odds, last_seen_at, commence_time')
    .eq('pick_regime', 'v2_clv').eq('status', 'open')
    .lte('commence_time', nowIso);
  if (!tickets || !tickets.length) return { frozen: 0 };

  let frozen = 0, novig = 0;
  for (const t of tickets) {
    const closeOdds = t.last_seen_odds != null ? t.last_seen_odds : t.open_odds;
    const closeLine = t.last_seen_line != null ? t.last_seen_line : t.open_line;
    const closeOppOdds = t.last_seen_opp_odds != null ? t.last_seen_opp_odds : null;

    // De-vig the close when we have both sides. A single side's implied price
    // includes the whole hold, so implied-minus-implied conflates line movement
    // with the book's margin and can't be pooled across markets whose holds
    // differ (totals ~4%, MLB moneylines ~6%+).
    let closeNovig = null;
    if (closeOdds != null && closeOppOdds != null) {
      const [sideNoVig] = removeVig(americanToImpliedProb(closeOdds), americanToImpliedProb(closeOppOdds));
      if (Number.isFinite(sideNoVig) && sideNoVig > 0 && sideNoVig < 1) {
        closeNovig = Math.round(sideNoVig * 1e4) / 1e4;
      }
    }

    const openImplied = t.open_odds != null ? americanToImpliedProb(t.open_odds) : null;
    const closeImplied = closeOdds != null ? americanToImpliedProb(closeOdds) : null;

    // Prefer the no-vig basis; fall back to single-side implied so a missing
    // opposite quote degrades the measurement instead of dropping the ticket.
    // clv_basis records which was used so the two are never pooled blindly —
    // the Phase 7 optimizer must filter on clv_basis='novig'.
    let clvProbDelta = null, clvBasis = null;
    if (closeNovig != null && t.placed_novig_prob != null) {
      clvProbDelta = Math.round((closeNovig - Number(t.placed_novig_prob)) * 1e4) / 1e4;
      clvBasis = 'novig';
      novig++;
    } else if (openImplied != null && closeImplied != null) {
      clvProbDelta = Math.round((closeImplied - openImplied) * 1e4) / 1e4;
      clvBasis = 'implied';
    }

    // "Beat the close" = your locked price implied a LOWER probability than the
    // close (you got a longer/better price). Positive delta = positive CLV.
    const clvLineDelta = (t.open_line != null && closeLine != null)
      ? Math.round((closeLine - t.open_line) * 100) / 100 : null;
    const beatClose = clvProbDelta != null ? clvProbDelta > 0 : null;
    const lagHours = (t.last_seen_at && t.commence_time)
      ? Math.round(((new Date(t.commence_time).getTime() - new Date(t.last_seen_at).getTime()) / 3.6e6) * 10) / 10
      : null;

    const { error } = await sb.from('performance_log').update({
      close_odds: closeOdds,
      close_line: closeLine,
      close_opp_odds: closeOppOdds,
      close_novig_prob: closeNovig,
      close_captured_at: t.last_seen_at || nowIso,
      close_lag_hours: lagHours,
      clv_prob_delta: clvProbDelta,
      clv_line_delta: clvLineDelta,
      clv_beat_close: beatClose,
      clv_basis: clvBasis,
      close_source: 'last_seen',
      status: 'closed',
    }).eq('pick_id', t.pick_id);
    if (!error) frozen++;
  }
  return { frozen, novig };
}

// American-odds profit for a win.
function profit(odds, units) {
  if (!odds || !units) return 0;
  return odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
}

// Grade a ticket against a final score. Returns 'W' | 'L' | 'P' | null.
function gradeTicket(t, awayScore, homeScore) {
  const market = t.market;
  const line = t.line != null ? parseFloat(t.line) : 0;
  const pick = t.pick || '';
  const nPick = norm(pick), nHome = norm(t.home_team || '');
  const pickedHome = nHome && (nPick.includes(nHome) || nHome.includes(nPick));

  if (market === 'moneyline') {
    if (awayScore === homeScore) return 'P';
    const homeWon = homeScore > awayScore;
    return pickedHome === homeWon ? 'W' : 'L';
  }
  if (market === 'spread') {
    const margin = pickedHome ? (homeScore + line) - awayScore : (awayScore + line) - homeScore;
    return margin > 0 ? 'W' : margin < 0 ? 'L' : 'P';
  }
  if (market === 'total') {
    const total = awayScore + homeScore;
    if (total === line) return 'P';
    const isOver = /over/i.test(pick);
    return isOver === (total > line) ? 'W' : 'L';
  }
  return null;
}

// Grade closed v2 tickets whose games have finished, by matching to ESPN finals.
// Anchored on game_date (not pick_date), so a pick logged weeks early still grades.
async function gradeClosedTickets() {
  const sb = db.getClient();
  if (!sb) return { graded: 0, reason: 'no_db' };

  const cutoffIso = new Date(Date.now() - 4 * 3600e3).toISOString(); // started >4h ago ≈ final
  const { data: tickets } = await sb.from('performance_log')
    .select('pick_id, league, market, pick, line, odds, final_units, away_team, home_team, game_date, espn_event_id, commence_time')
    .eq('pick_regime', 'v2_clv').eq('status', 'closed').is('graded_at', null)
    .lt('commence_time', cutoffIso)
    .order('commence_time', { ascending: true }).limit(500);
  if (!tickets || !tickets.length) return { graded: 0 };

  // Batch ESPN fetches by league + game_date.
  const groups = {};
  for (const t of tickets) (groups[`${t.league}|${t.game_date}`] = groups[`${t.league}|${t.game_date}`] || []).push(t);

  let graded = 0, unmatched = 0;
  for (const key of Object.keys(groups)) {
    const [league, gameDate] = key.split('|');
    const path = ESPN_PATH[league];
    if (!path || !gameDate) continue;

    // 2026-08-02: game_date is currently derived from the UTC slice of
    // commence_time (predictions.js), so an evening ET game is stamped with the
    // NEXT day's date. A single-date scoreboard fetch therefore missed those
    // games entirely and they sat at status='closed' forever, silently.
    // Fetch game_date AND the prior date and merge — ESPN is free and
    // unlimited, and this is immune to whichever day-boundary convention ESPN
    // uses. Keep this even after game_date is fixed: it costs one free call and
    // permanently closes the boundary failure mode.
    const dayMs = 864e5;
    const d0 = new Date(`${gameDate}T00:00:00Z`).getTime();
    const dates = [
      new Date(d0 - dayMs).toISOString().slice(0, 10).replace(/-/g, ''),
      gameDate.replace(/-/g, ''),
    ];

    const events = [];
    for (const ds of dates) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ds}`);
        if (res.ok) { const j = await res.json(); if (j.events) events.push(...j.events); }
      } catch (e) { /* try the other date */ }
    }
    if (!events.length) continue;

    const byId = {}, byTeams = {};
    for (const e of events) {
      const comp = e.competitions && e.competitions[0];
      if (!comp) continue;
      const cs = comp.competitors || [];
      const h = cs.find(c => c.homeAway === 'home'), a = cs.find(c => c.homeAway === 'away');
      if (!h || !a) continue;
      const ev = {
        id: e.id,
        completed: !!(comp.status && comp.status.type && comp.status.type.completed),
        awayScore: parseInt(a.score, 10), homeScore: parseInt(h.score, 10),
        awayName: a.team && (a.team.displayName || a.team.name) || '',
        homeName: h.team && (h.team.displayName || h.team.name) || '',
      };
      // Merging two dates can surface the same event twice; a completed record
      // always wins over a scheduled one.
      const tk = `${norm(ev.awayName)}@${norm(ev.homeName)}`;
      if (!byId[ev.id] || ev.completed) byId[ev.id] = ev;
      if (!byTeams[tk] || ev.completed) byTeams[tk] = ev;
    }

    for (const t of groups[key]) {
      let ev = t.espn_event_id ? byId[t.espn_event_id] : null;
      if (!ev) ev = byTeams[`${norm(t.away_team)}@${norm(t.home_team)}`];
      if (!ev || !ev.completed || !Number.isFinite(ev.awayScore) || !Number.isFinite(ev.homeScore)) { unmatched++; continue; }
      const result = gradeTicket(t, ev.awayScore, ev.homeScore);
      if (!result) { unmatched++; continue; }
      const ur = result === 'W' ? profit(t.odds, t.final_units) : result === 'L' ? -(t.final_units || 0) : 0;
      const { error } = await sb.from('performance_log').update({
        result,
        unit_return: Math.round(ur * 100) / 100,
        away_score: ev.awayScore, home_score: ev.homeScore,
        espn_event_id: ev.id, grade_source: 'espn',
        graded_at: new Date().toISOString(), status: 'graded',
      }).eq('pick_id', t.pick_id);
      if (!error) graded++;
    }
  }
  // Surfaced so a silent match failure shows up in the run log instead of six
  // months later — this is the §13 "unmatched ESPN id" tripwire in embryo.
  if (unmatched) console.warn(`[clv] gradeClosedTickets: ${unmatched} closed ticket(s) had no completed ESPN match`);
  return { graded, unmatched };
}

module.exports = { rollLastSeen, freezeClosedTickets, gradeClosedTickets, gradeTicket };
