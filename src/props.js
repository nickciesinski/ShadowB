'use strict';
const { americanToImpliedProb } = require('./market-pricing');
/**
 * props.js — Player Props Edge Detection
 * Fetches player prop lines from the Odds API, computes consensus lines,
 * and identifies +EV edges where individual books diverge from consensus.
 */
const { getValues, setValues, clearSheet } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, SPORTS } = require('./config');
const { logApiCall } = require('./monitoring');
const { getAllPropModifiers, DEFAULT_MODIFIER } = require('./prop-weights');
const { getStatusImpacts } = require('./prop-status');
const { scoreEdge, loadScoringContext } = require('./prop-scoring');

const ODDS_API_COST_PER_CALL = 0.001;

/**
 * Prop confidence → unit sizing.
 * Same scale as the main picks system (confidenceToUnits in predictions.js).
 * 1-2 → 0.01, 3-4 → 0.05, 5 → 0.1, 6-7 → 0.15, 8 → 0.2, 9 → 0.4, 10 → 0.5
 */
function propConfidenceToUnits(confidence) {
  const c = parseInt(confidence) || 5;
  if (c <= 2) return 0.01;
  if (c <= 4) return 0.05;
  if (c === 5) return 0.1;
  if (c <= 7) return 0.15;
  if (c === 8) return 0.2;
  if (c === 9) return 0.4;
  return 0.5;
}

// Minimum prop edges PER LEAGUE per day so no sport gets squeezed out.
// MLB's volume advantage used to consume all 30 global slots; now each
// active league gets its own floor.  Total output = sum of per-league floors
// + any elite edges above PROP_ELITE_EDGE_PCT that didn't fit.
const PROP_PER_LEAGUE_FLOOR = 10;
// Edges above this threshold are considered "elite" and always included
// regardless of the per-league floor.
const PROP_ELITE_EDGE_PCT = 2.0;

// Only surface edges from books Nick actually uses. Consensus is still
// calculated from ALL books (more data = more accurate), but Prop_Combos
// output is filtered to actionable books only.
const PREFERRED_BOOKS = [
  'Bovada', 'MyBookie.ag', 'FanDuel', 'DraftKings',
];

const PROPS_SHEET   = SHEETS.PLAYER_PROPS;    // 'Player_Props'
const COMBOS_SHEET  = SHEETS.PLATFORM_COMBOS;  // 'Prop_Combos'

// Prop markets to fetch — covers the main PrizePicks/Betr categories
const PROP_MARKETS = {
  basketball_nba: [
    'player_points', 'player_rebounds', 'player_assists',
    'player_threes', 'player_points_rebounds_assists',
  ],
  baseball_mlb: [
    'batter_total_bases', 'batter_hits', 'batter_home_runs',
    'pitcher_strikeouts', 'pitcher_outs',
  ],
  icehockey_nhl: [
    'player_points', 'player_shots_on_goal', 'player_assists',
  ],
  americanfootball_nfl: [
    'player_pass_yds', 'player_rush_yds', 'player_reception_yds',
    'player_pass_tds', 'player_anytime_td',
  ],
};

// Platform-specific market name mapping
const PLATFORM_MARKETS = {
  // Odds API market → Platform display names
  player_points: { prizepicks: 'Points', underdog: 'PTS', betr: 'Points', sleepr: 'Fantasy Points' },
  player_rebounds: { prizepicks: 'Rebounds', underdog: 'REB', betr: 'Rebounds', sleepr: 'Rebounds' },
  player_assists: { prizepicks: 'Assists', underdog: 'AST', betr: 'Assists', sleepr: 'Assists' },
  player_threes: { prizepicks: '3-Pointers Made', underdog: '3PM', betr: 'Threes', sleepr: '3PM' },
  player_points_rebounds_assists: { prizepicks: 'Pts+Rebs+Asts', underdog: 'PRA', betr: 'PRA', sleepr: 'PRA' },
  batter_total_bases: { prizepicks: 'Total Bases', underdog: 'Total Bases', betr: 'Total Bases', sleepr: 'Total Bases' },
  batter_hits: { prizepicks: 'Hits', underdog: 'Hits', betr: 'Hits', sleepr: 'Hits' },
  batter_home_runs: { prizepicks: 'Home Runs', underdog: 'HR', betr: 'Home Runs', sleepr: 'HR' },
  pitcher_strikeouts: { prizepicks: 'Strikeouts', underdog: 'K', betr: 'Strikeouts', sleepr: 'K' },
  pitcher_outs: { prizepicks: 'Pitching Outs', underdog: 'Outs', betr: 'Outs', sleepr: 'Outs' },
  player_shots_on_goal: { prizepicks: 'Shots on Goal', underdog: 'SOG', betr: 'Shots', sleepr: 'SOG' },
  player_pass_yds: { prizepicks: 'Pass Yards', underdog: 'PYDS', betr: 'Pass Yards', sleepr: 'Pass Yards' },
  player_rush_yds: { prizepicks: 'Rush Yards', underdog: 'RYDS', betr: 'Rush Yards', sleepr: 'Rush Yards' },
  player_reception_yds: { prizepicks: 'Rec Yards', underdog: 'RCYDS', betr: 'Rec Yards', sleepr: 'Rec Yards' },
  player_pass_tds: { prizepicks: 'Pass TDs', underdog: 'PTD', betr: 'Pass TDs', sleepr: 'Pass TDs' },
  player_anytime_td: { prizepicks: 'Anytime TD', underdog: 'TD', betr: 'Anytime TD', sleepr: 'TD' },
};

/**
 * List events for a given sport. The Odds API requires this as step 1
 * of the player-props flow; /events?markets=X does NOT return bookmakers,
 * you have to fetch /events/{eventId}/odds per event.
 */
async function listSportEvents(sport) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  await logApiCall({ endpoint: `odds-api:/sports/${sport}/events`, costEstimate: ODDS_API_COST_PER_CALL });
  if (!res.ok) throw new Error(`Odds API events ${res.status} for ${sport}`);
  return res.json();
}

/**
 * Fetch player-prop odds for a single event across a list of markets.
 * Returns the full event response (with .bookmakers populated) or null.
 */
async function fetchEventProps(sport, eventId, markets) {
  const marketParam = Array.isArray(markets) ? markets.join(',') : markets;
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds`
    + `?apiKey=${ODDS_API_KEY}&regions=us&markets=${marketParam}&oddsFormat=american`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  await logApiCall({ endpoint: `odds-api:/events/${eventId}/odds`, costEstimate: ODDS_API_COST_PER_CALL });
  if (!res.ok) {
    console.warn(`[props] Event ${eventId} odds ${res.status} (markets=${marketParam})`);
    return null;
  }
  return res.json();
}

/**
 * Parse a single event's odds response into flat prop rows.
 * If marketFilter is null, accepts all prop markets present in the response.
 */
function parseProps(event, marketFilter = null) {
  const rows = [];
  if (!event) return rows;
  const gameLabel = `${event.away_team} @ ${event.home_team}`;
  const commence = event.commence_time;
  for (const bm of (event.bookmakers || [])) {
    for (const mkt of (bm.markets || [])) {
      if (marketFilter && mkt.key !== marketFilter) continue;
      for (const outcome of (mkt.outcomes || [])) {
        rows.push([
          gameLabel,
          commence,
          bm.title,
          outcome.description || outcome.name || '', // Player name (in per-event odds, "description" holds the player)
          outcome.name || '',                        // Over/Under
          outcome.price,
          outcome.point || '',
          mkt.key,                                   // actual market key from response
        ]);
      }
    }
  }
  return rows;
}

/**
 * Deduplicate prop lines into consensus per player+market.
 * Groups by player+market+direction, takes median line and best price.
 * Returns array of { game, player, market, line, overPrice, underPrice, overImplied, underImplied }
 */
function buildPropConsensus(propRows) {
  const grouped = {}; // key: "player|market|line" -> { overPrices, underPrices, game }

  for (const row of propRows) {
    const game = row[0];
    const player = row[3];
    const direction = row[4]; // 'Over' or 'Under'
    const price = parseInt(row[5]) || 0;
    const line = row[6];
    const market = row[7];

    const key = `${player}|${market}|${line}`;
    if (!grouped[key]) grouped[key] = { game, player, market, line, overPrices: [], underPrices: [] };

    if (direction === 'Over') {
      grouped[key].overPrices.push(price);
    } else {
      grouped[key].underPrices.push(price);
    }
  }

  return Object.values(grouped).map(g => {
    const medianOf = arr => {
      if (arr.length === 0) return -110;
      arr.sort((a, b) => a - b);
      return arr[Math.floor(arr.length / 2)];
    };
    const overPrice = medianOf(g.overPrices);
    const underPrice = medianOf(g.underPrices);
    const impliedProb = americanToImpliedProb;
    return {
      game: g.game,
      player: g.player,
      market: g.market,
      line: g.line,
      overPrice,
      underPrice,
      overImplied: (impliedProb(overPrice) * 100).toFixed(1),
      underImplied: (impliedProb(underPrice) * 100).toFixed(1),
    };
  });
}

/**
 * Update the Player Props sheet with fresh prop lines from all sports.
 * Trigger 6: 6:00 AM ET daily.
 */
async function updatePlayerProps() {
  let allRows = [['Game', 'Time', 'Book', 'Player', 'Description', 'Price', 'Line', 'Market', 'League']];
  let totalEvents = 0;
  let totalRows = 0;

  for (const [league, sportConfig] of Object.entries(SPORTS)) {
    const sportKey = sportConfig.key;
    const markets = PROP_MARKETS[sportKey] || [];
    if (markets.length === 0) continue;

    let events = [];
    try {
      events = await listSportEvents(sportKey);
    } catch (err) {
      console.warn(`[props] ${league}: listSportEvents failed:`, err.message);
      continue;
    }
    if (!Array.isArray(events) || events.length === 0) {
      console.log(`[props] ${league}: no events today`);
      continue;
    }
    totalEvents += events.length;

    // Fetch all markets for each event in one request (comma-separated markets param).
    // Per Odds API docs each market in the list counts toward usage, so this is
    // equivalent in cost to looping markets individually but way fewer round trips.
    for (const ev of events) {
      try {
        const eventData = await fetchEventProps(sportKey, ev.id, markets);
        if (!eventData) continue;
        const rows = parseProps(eventData, null);
        for (const row of rows) row.push(league);
        allRows = allRows.concat(rows);
        totalRows += rows.length;
      } catch (err) {
        console.warn(`[props] ${league}/${ev.id}: fetch failed:`, err.message);
      }
    }
    console.log(`[props] ${league}: ${events.length} events → ${totalRows} prop rows so far`);
  }

  await clearSheet(SPREADSHEET_ID, PROPS_SHEET);
  await setValues(SPREADSHEET_ID, PROPS_SHEET, 'A1', allRows);
  console.log(`[props] Wrote ${allRows.length - 1} prop rows across ${totalEvents} events`);
  return allRows;
}

/**
 * Analyze player props for +EV edges using consensus vs individual book lines.
 * Replaces GPT-based picks with pure math edge detection.
 * Trigger 7: 6:15 AM ET daily.
 */
async function generatePropEdges() {
  console.log('[props] Computing prop edges...');

  const rawProps = await getValues(SPREADSHEET_ID, PROPS_SHEET);
  if (!rawProps || rawProps.length < 2) {
    console.warn(`[props] ⚠️ No prop data available at ${new Date().toISOString()}.`);
    return;
  }

  const propRows = rawProps.slice(1);

  // Helper: American odds → implied probability
  const impliedProb = americanToImpliedProb;

  // Step 1: Group all lines by player|market|line
  // Each entry tracks per-book prices and the consensus
  const grouped = {}; // key: "player|market|line" → { game, league, player, market, line, books: { bookName: { overPrice, underPrice } } }

  for (const row of propRows) {
    const game = row[0];
    const book = row[2];
    const player = row[3];
    const direction = row[4]; // 'Over' or 'Under'
    const price = parseInt(row[5]) || 0;
    const line = row[6];
    const market = row[7];
    const league = row[8] || '';

    const key = `${player}|${market}|${line}`;
    if (!grouped[key]) grouped[key] = { game, league, player, market, line, books: {} };
    if (!grouped[key].books[book]) grouped[key].books[book] = {};

    if (direction === 'Over') {
      grouped[key].books[book].overPrice = price;
    } else if (direction === 'Under') {
      grouped[key].books[book].underPrice = price;
    }
  }

  // Step 2: Compute consensus and per-book edges
  const allEdges = [];

  for (const g of Object.values(grouped)) {
    const bookNames = Object.keys(g.books);
    if (bookNames.length < 2) continue; // Need multiple books for meaningful consensus

    // Consensus: median implied prob across books
    const overProbs = [];
    const underProbs = [];
    for (const b of Object.values(g.books)) {
      if (b.overPrice) overProbs.push(impliedProb(b.overPrice));
      if (b.underPrice) underProbs.push(impliedProb(b.underPrice));
    }

    const median = arr => {
      if (!arr.length) return 0.5;
      arr.sort((a, b) => a - b);
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };

    const consensusOverProb = median(overProbs);
    const consensusUnderProb = median(underProbs);

    // Platform market names
    const platformNames = PLATFORM_MARKETS[g.market] || {};

    // For each book, compute edge on both sides. We keep ALL edges (including
    // negative) so we can always surface the top N picks of the day even when
    // nothing clears the elite threshold. Parallel to the pick-coverage rule.
    for (const [bookName, prices] of Object.entries(g.books)) {
      // Over edge
      if (prices.overPrice) {
        const bookProb = impliedProb(prices.overPrice);
        const edge = consensusOverProb - bookProb; // positive = book prices Over too high (good for bettor)
        allEdges.push({
          player: g.player,
          market: g.market,
          marketDisplay: (g.market || '').replace(/^(player_|pitcher_|batter_)/, '').replace(/_/g, ' '),
          line: g.line,
          direction: 'Over',
          book: bookName,
          bookOdds: prices.overPrice,
          consensusProb: (consensusOverProb * 100).toFixed(1),
          bookProb: (bookProb * 100).toFixed(1),
          edge: (edge * 100).toFixed(1),
          edgeNum: edge * 100,
          numBooks: bookNames.length,
          game: g.game,
          league: g.league,
          prizepicks: platformNames.prizepicks || '',
          underdog: platformNames.underdog || '',
          betr: platformNames.betr || '',
          sleepr: platformNames.sleepr || '',
        });
      }

      // Under edge
      if (prices.underPrice) {
        const bookProb = impliedProb(prices.underPrice);
        const edge = consensusUnderProb - bookProb;
        allEdges.push({
          player: g.player,
          market: g.market,
          marketDisplay: (g.market || '').replace(/^(player_|pitcher_|batter_)/, '').replace(/_/g, ' '),
          line: g.line,
          direction: 'Under',
          book: bookName,
          bookOdds: prices.underPrice,
          consensusProb: (consensusUnderProb * 100).toFixed(1),
          bookProb: (bookProb * 100).toFixed(1),
          edge: (edge * 100).toFixed(1),
          edgeNum: edge * 100,
          numBooks: bookNames.length,
          game: g.game,
          league: g.league,
          prizepicks: platformNames.prizepicks || '',
          underdog: platformNames.underdog || '',
          betr: platformNames.betr || '',
          sleepr: platformNames.sleepr || '',
        });
      }
    }
  }

  // Sort by edge descending (biggest edges first)
  allEdges.sort((a, b) => b.edgeNum - a.edgeNum);

  // Filter to preferred books only — consensus uses all books, but we only
  // surface actionable edges from Bovada/BetOnline/MyBookie.
  const prefSet = new Set(PREFERRED_BOOKS.map(b => b.toLowerCase()));
  const actionableEdges = allEdges.filter(e => prefSet.has((e.book || '').toLowerCase()));
  console.log(`[props] ${allEdges.length} total edges, ${actionableEdges.length} from preferred books (${PREFERRED_BOOKS.join(', ')})`);

  // ── PHASE 2: Multi-factor scoring, status impacts, and confidence ──

  // Load scoring context (player history, book stats, tiers, weights)
  // Context is loaded once per league group — shared across all edges
  const scoringContexts = {};
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    try {
      scoringContexts[league] = await loadScoringContext(league);
    } catch (err) {
      console.warn(`[props] Could not load scoring context for ${league}: ${err.message}`);
      scoringContexts[league] = { bookStats: {}, playerHistory: {}, tierMap: {}, weights: null };
    }
  }

  // Load CLV market modifiers (still used as one factor in scoring)
  const weightsByLeague = {};
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    try {
      weightsByLeague[league] = await getAllPropModifiers(league);
    } catch (err) {
      console.warn(`[props] Could not load ${league} prop weights: ${err.message}`);
      weightsByLeague[league] = {};
    }
  }

  // Load status impacts (injury/scratch teammate bumps)
  let statusImpacts = {};
  try {
    statusImpacts = await getStatusImpacts();
  } catch (err) {
    console.warn(`[props] Could not load status impacts: ${err.message}`);
  }

  // Score each edge using 6-factor model
  for (const e of actionableEdges) {
    // CLV market modifier (fed into scoring model as one factor)
    const leagueWeights = weightsByLeague[e.league] || {};
    const weightMod = leagueWeights[e.market] || DEFAULT_MODIFIER;
    e.weightModifier = weightMod;

    // Status impact (teammate bump from key player scratch)
    const statusKey = `${e.league}|${e.player}`;
    const impact = statusImpacts[statusKey];
    let statusBump = 0;
    if (impact && impact.affectedMarkets.includes(e.market)) {
      statusBump = impact.edgeBump;
    }
    e.statusBump = statusBump;

    // Adjusted edge = raw edge × CLV modifier + status bump
    e.adjustedEdge = parseFloat(((e.edgeNum * weightMod) + statusBump).toFixed(2));

    // Multi-factor confidence scoring
    const ctx = scoringContexts[e.league] || scoringContexts.MLB;
    const { rawScore, confidence, factors } = scoreEdge(e, ctx);
    e.rawScore = rawScore;
    e.confidence = confidence;
    e.scoringFactors = factors;

    // Bonus: +1 confidence if status bump active (not captured by model yet)
    if (statusBump > 0) {
      e.confidence = Math.min(10, e.confidence + 1);
    }

    // Unit sizing (same scale as main picks)
    e.units = propConfidenceToUnits(e.confidence);
  }

  // Re-sort by adjusted edge
  actionableEdges.sort((a, b) => b.adjustedEdge - a.adjustedEdge);

  // Per-league floor: guarantee each active sport gets representation,
  // then add any remaining elite edges that didn't already make the cut.
  const combined = [];
  const seen = new Set();
  const addEdge = (e) => {
    const k = `${e.player}|${e.market}|${e.line}|${e.direction}|${e.book}`;
    if (seen.has(k)) return;
    seen.add(k);
    combined.push(e);
  };

  // 1. Top N per league (sorted by adjustedEdge within each league)
  const byLeague = {};
  for (const e of actionableEdges) {
    if (!byLeague[e.league]) byLeague[e.league] = [];
    byLeague[e.league].push(e);
  }
  for (const [league, edges] of Object.entries(byLeague)) {
    edges.sort((a, b) => b.adjustedEdge - a.adjustedEdge);
    for (const e of edges.slice(0, PROP_PER_LEAGUE_FLOOR)) addEdge(e);
  }

  // 2. Any elite edge (≥ threshold) that wasn't already included
  const elite = actionableEdges.filter(e => e.adjustedEdge >= PROP_ELITE_EDGE_PCT);
  for (const e of elite) addEdge(e);

  combined.sort((a, b) => b.adjustedEdge - a.adjustedEdge);

  console.log(`[props] ${Object.keys(byLeague).length} leagues, ${elite.length} elite (≥${PROP_ELITE_EDGE_PCT}%), writing ${combined.length} rows`);

  // Write to Prop_Combos sheet (expanded schema with weights, confidence, units)
  const ts = new Date().toISOString();
  const outputRows = [['Timestamp', 'League', 'Player', 'Market', 'Line', 'Direction',
    'Book', 'BookOdds', 'BookProb', 'ConsensusProb', 'Edge', 'Game',
    'PrizePicks', 'Underdog', 'Betr', 'Sleepr',
    'WeightModifier', 'StatusBump', 'AdjustedEdge', 'Confidence', 'Units']];
  for (const e of combined) {
    outputRows.push([
      ts,
      e.league,
      e.player,
      e.marketDisplay,
      e.line,
      e.direction,
      e.book,
      e.bookOdds,
      e.bookProb,
      e.consensusProb,
      e.edge,
      e.game,
      e.prizepicks,
      e.underdog,
      e.betr,
      e.sleepr,
      e.weightModifier,
      e.statusBump,
      e.adjustedEdge,
      e.confidence,
      e.units,
    ]);
  }

  await clearSheet(SPREADSHEET_ID, COMBOS_SHEET);
  await setValues(SPREADSHEET_ID, COMBOS_SHEET, 'A1', outputRows);
  console.log(`[props] Wrote ${combined.length} prop edges to ${COMBOS_SHEET}`);
}

// ── ESPN Box Score Fetching ──────────────────────────────────────

const ESPN_SPORT_MAP = {
  NBA: { path: 'basketball/nba', type: 'basketball' },
  MLB: { path: 'baseball/mlb', type: 'baseball' },
  NHL: { path: 'hockey/nhl', type: 'hockey' },
  NFL: { path: 'football/nfl', type: 'football' },
};

// Map Odds API prop market keys → ESPN stat extraction functions.
// Each extractor returns the numeric stat value from a player's stats array.
const PROP_STAT_EXTRACTORS = {
  // NBA
  player_points: (stats) => findStat(stats, 'points'),
  player_rebounds: (stats) => findStat(stats, 'rebounds'),
  player_assists: (stats) => findStat(stats, 'assists'),
  player_threes: (stats) => findStat(stats, 'threePointFieldGoalsMade'),
  player_points_rebounds_assists: (stats) => {
    const p = findStat(stats, 'points');
    const r = findStat(stats, 'rebounds');
    const a = findStat(stats, 'assists');
    return (p !== null && r !== null && a !== null) ? p + r + a : null;
  },
  // MLB batting
  batter_total_bases: (stats) => findStat(stats, 'totalBases'),
  batter_hits: (stats) => findStat(stats, 'hits'),
  batter_home_runs: (stats) => findStat(stats, 'homeRuns'),
  // MLB pitching
  pitcher_strikeouts: (stats) => findStat(stats, 'strikeouts'),
  pitcher_outs: (stats) => findStat(stats, 'pitchingOuts') ?? findStat(stats, 'innings'), // fallback
  // NHL
  player_shots_on_goal: (stats) => findStat(stats, 'shotsOnGoal') ?? findStat(stats, 'shots'),
  // player_points and player_assists already defined above — NHL reuses them
  // NFL
  player_pass_yds: (stats) => findStat(stats, 'passingYards'),
  player_rush_yds: (stats) => findStat(stats, 'rushingYards'),
  player_reception_yds: (stats) => findStat(stats, 'receivingYards'),
  player_pass_tds: (stats) => findStat(stats, 'passingTouchdowns'),
  player_anytime_td: (stats) => {
    const rush = findStat(stats, 'rushingTouchdowns') || 0;
    const rec = findStat(stats, 'receivingTouchdowns') || 0;
    const pass = findStat(stats, 'passingTouchdowns') || 0;
    return rush + rec + pass > 0 ? 1 : 0; // binary: scored or not
  },
};

/** Find a named stat in ESPN's stats array or categories structure. */
function findStat(statsObj, name) {
  if (!statsObj) return null;
  // ESPN API returns stats in different formats depending on endpoint.
  // Format 1: array of { name, value } or { abbreviation, displayValue }
  if (Array.isArray(statsObj)) {
    for (const s of statsObj) {
      if (s.name === name || s.abbreviation === name) {
        const v = parseFloat(s.displayValue ?? s.value ?? s.stat);
        return isFinite(v) ? v : null;
      }
    }
    return null;
  }
  // Format 2: flat object { points: "24", rebounds: "10" }
  if (typeof statsObj === 'object') {
    const v = parseFloat(statsObj[name]);
    return isFinite(v) ? v : null;
  }
  return null;
}

/**
 * Fetch box score player stats from ESPN for yesterday's games.
 * Returns: { "PlayerName|LEAGUE": { stats: [...], allStats: {} } }
 */
async function fetchBoxScoreStats(leagues) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');

  const playerStats = {}; // "normalizedName|LEAGUE" → flat stats object

  for (const league of leagues) {
    const espn = ESPN_SPORT_MAP[league];
    if (!espn) continue;

    try {
      // Step 1: Get scoreboard for yesterday
      const sbUrl = `https://site.api.espn.com/apis/site/v2/sports/${espn.path}/scoreboard?dates=${dateStr}`;
      const sbRes = await fetch(sbUrl, { signal: AbortSignal.timeout(30000) });
      if (!sbRes.ok) { console.warn(`[props-grade] ESPN scoreboard ${league}: ${sbRes.status}`); continue; }
      const sbData = await sbRes.json();
      const events = sbData.events || [];
      console.log(`[props-grade] ${league}: ${events.length} events on ${dateStr}`);

      // Step 2: For each completed event, fetch box score
      for (const event of events) {
        const status = event.status?.type?.completed;
        if (!status) continue;
        const eventId = event.id;

        try {
          const boxUrl = `https://site.api.espn.com/apis/site/v2/sports/${espn.path}/summary?event=${eventId}`;
          const boxRes = await fetch(boxUrl, { signal: AbortSignal.timeout(30000) });
          if (!boxRes.ok) continue;
          const boxData = await boxRes.json();

          // Extract player stats from boxscore
          const boxscore = boxData.boxscore;
          if (!boxscore) continue;

          // ESPN structure: boxscore.players = [ { team, statistics: [ { athletes: [ { athlete, stats } ] } ] } ]
          for (const teamBlock of (boxscore.players || [])) {
            for (const statGroup of (teamBlock.statistics || [])) {
              const statNames = (statGroup.names || []).map(n => String(n));
              for (const athlete of (statGroup.athletes || [])) {
                const name = athlete.athlete?.displayName || '';
                if (!name) continue;
                const normalizedName = normalizeName(name);
                const key = `${normalizedName}|${league}`;
                const statValues = athlete.stats || [];

                // Build a flat stats object from parallel arrays
                const flatStats = {};
                for (let si = 0; si < statNames.length && si < statValues.length; si++) {
                  flatStats[statNames[si]] = statValues[si];
                }

                // Merge if player appeared in multiple stat groups (pitching + batting)
                if (!playerStats[key]) playerStats[key] = {};
                Object.assign(playerStats[key], flatStats);
              }
            }
          }
        } catch (err) {
          console.warn(`[props-grade] Box score ${league}/${eventId} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[props-grade] ESPN ${league} scoreboard error:`, err.message);
    }
  }

  console.log(`[props-grade] Fetched stats for ${Object.keys(playerStats).length} players`);
  return playerStats;
}

/** Normalize player name for fuzzy matching: lowercase, strip accents, trim suffixes. */
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .toLowerCase()
    .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '')           // strip suffixes
    .trim();
}

/**
 * Grade prop edges against actual player stats from ESPN box scores.
 * Reads Prop_Combos (today's edges), fetches ESPN box scores,
 * compares actual stats vs prop lines, writes W/L results to Prop_Performance.
 * Called by trigger12 (11 PM ET daily, after games end).
 */
async function gradePropPicks() {
  console.log('[props] Grading prop edges against ESPN box scores...');
  const combos = await getValues(SPREADSHEET_ID, COMBOS_SHEET);
  if (!combos || combos.length < 2) {
    console.warn('[props] No prop edges to grade.');
    return;
  }

  const edges = combos.slice(1);

  // Determine which leagues have edges to grade
  const activeLeagues = [...new Set(edges.map(r => r[1]).filter(Boolean))];
  console.log(`[props] Active leagues: ${activeLeagues.join(', ')}`);

  // Fetch box score stats from ESPN
  const playerStats = await fetchBoxScoreStats(activeLeagues);
  if (Object.keys(playerStats).length === 0) {
    console.warn('[props] No box score stats available — cannot grade props.');
    return;
  }

  // Map Prop_Combos market display names back to API keys for stat extraction.
  // Prop_Combos col 3 is the display name (e.g., "points" not "player_points").
  // We need the original API market key for PROP_STAT_EXTRACTORS.
  const displayToKey = {};
  for (const [apiKey, platforms] of Object.entries(PLATFORM_MARKETS)) {
    const display = apiKey.replace(/^(player_|pitcher_|batter_)/, '').replace(/_/g, ' ');
    displayToKey[display] = apiKey;
    // Also map platform-specific names
    for (const pName of Object.values(platforms || {})) {
      displayToKey[pName.toLowerCase()] = apiKey;
    }
  }

  const perfSheet = SHEETS.PROP_PERFORMANCE || 'Prop_Performance';
  const ts = new Date().toISOString();
  const perfRows = [];
  let wins = 0, losses = 0, pushes = 0, unmatched = 0;

  for (const row of edges) {
    const league = row[1] || '';
    const player = row[2] || '';
    const marketDisplay = row[3] || '';
    const line = parseFloat(row[4]);
    const direction = row[5] || '';   // 'Over' or 'Under'
    const book = row[6] || '';
    const edge = row[10] || '';
    const adjustedEdge = row[18] || edge;
    const confidence = row[19] || '';
    const units = row[20] || '';

    // Look up the market API key
    const marketKey = displayToKey[marketDisplay.toLowerCase()] || displayToKey[marketDisplay] || '';

    // Look up player stats
    const normalizedPlayer = normalizeName(player);
    const statsKey = `${normalizedPlayer}|${league}`;
    const stats = playerStats[statsKey];

    let actual = null;
    let result = 'UNMATCHED';

    if (stats && marketKey && PROP_STAT_EXTRACTORS[marketKey]) {
      actual = PROP_STAT_EXTRACTORS[marketKey](stats);
    }

    if (actual !== null && isFinite(line)) {
      // Special case: anytime TD is binary (1 = scored, 0 = didn't)
      if (marketKey === 'player_anytime_td') {
        if (direction === 'Over') {
          result = actual >= 1 ? 'W' : 'L';
        } else {
          result = actual === 0 ? 'W' : 'L';
        }
      } else if (direction === 'Over') {
        result = actual > line ? 'W' : actual === line ? 'P' : 'L';
      } else {
        result = actual < line ? 'W' : actual === line ? 'P' : 'L';
      }

      if (result === 'W') wins++;
      else if (result === 'L') losses++;
      else if (result === 'P') pushes++;
    } else {
      unmatched++;
    }

    perfRows.push([
      ts, league, player, marketDisplay, line || '', direction, book,
      edge, actual !== null ? actual : '', result,
      adjustedEdge, confidence, units,
    ]);
  }

  // Write results to Prop_Performance (append to keep history)
  const header = ['Timestamp', 'League', 'Player', 'Market', 'Line', 'Direction',
    'Book', 'Edge', 'Actual', 'Result', 'AdjustedEdge', 'Confidence', 'Units'];

  const existing = await getValues(SPREADSHEET_ID, perfSheet);
  if (!existing || existing.length === 0) {
    await setValues(SPREADSHEET_ID, perfSheet, 'A1', [header, ...perfRows]);
  } else {
    const nextRow = existing.length + 1;
    await setValues(SPREADSHEET_ID, perfSheet, `A${nextRow}`, perfRows);
  }

  console.log(`[props] Graded ${perfRows.length} prop edges: ${wins}W ${losses}L ${pushes}P, ${unmatched} unmatched`);
  if (wins + losses > 0) {
    console.log(`[props] Prop win rate: ${(wins / (wins + losses) * 100).toFixed(1)}%`);
  }
  return { wins, losses, pushes, unmatched };
}

module.exports = { updatePlayerProps, generatePropEdges, gradePropPicks };
