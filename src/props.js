'use strict';
/**
 * props.js — Player Props Edge Detection
 * Fetches player prop lines from the Odds API, computes consensus lines,
 * and identifies +EV edges where individual books diverge from consensus.
 */
const { getValues, setValues, clearSheet } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, SPORTS } = require('./config');

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
 * Fetch player prop odds from The Odds API for a given sport and market.
 */
async function fetchPropOdds(sport, market) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${ODDS_API_KEY}&regions=us&markets=${market}&oddsFormat=american`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Odds API error ${res.status} for ${market}`);
  return res.json();
}

/**
 * Parse raw event data into flat prop rows.
 */
function parseProps(events, market) {
  const rows = [];
  for (const event of events) {
    const gameLabel = `${event.away_team} @ ${event.home_team}`;
    const commence = event.commence_time;
    for (const bm of (event.bookmakers || [])) {
      for (const mkt of (bm.markets || [])) {
        if (mkt.key !== market) continue;
        for (const outcome of mkt.outcomes) {
          rows.push([
            gameLabel,
            commence,
            bm.title,
            outcome.name,         // Player name
            outcome.description || '', // Over/Under
            outcome.price,
            outcome.point || '',
            market,
          ]);
        }
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
    const impliedProb = (odds) => {
      const o = parseFloat(odds);
      return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
    };
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

  for (const [league, sportConfig] of Object.entries(SPORTS)) {
    const sportKey = sportConfig.key;
    const markets = PROP_MARKETS[sportKey] || [];
    for (const market of markets) {
      try {
        const events = await fetchPropOdds(sportKey, market);
        const rows = parseProps(events, market);
        // Add league to each row
        for (const row of rows) row.push(league);
        allRows = allRows.concat(rows);
        console.log(`[props] ${league}/${market}: ${rows.length} rows`);
      } catch (err) {
        console.warn(`[props] Failed ${league}/${market}:`, err.message);
      }
    }
  }

  await clearSheet(SPREADSHEET_ID, PROPS_SHEET);
  await setValues(SPREADSHEET_ID, PROPS_SHEET, 'A1', allRows);
  console.log(`[props] Wrote ${allRows.length - 1} prop rows`);
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
  const impliedProb = (odds) => {
    const o = parseFloat(odds);
    if (isNaN(o) || o === 0) return 0.5;
    return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
  };

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

    // For each book, compute edge on both sides
    for (const [bookName, prices] of Object.entries(g.books)) {
      // Over edge
      if (prices.overPrice) {
        const bookProb = impliedProb(prices.overPrice);
        const edge = consensusOverProb - bookProb; // positive = book prices Over too high (good for bettor)
        if (edge > 0.02) { // Only show 2%+ edges
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
            game: g.game,
            league: g.league,
            prizepicks: platformNames.prizepicks || '',
            underdog: platformNames.underdog || '',
            betr: platformNames.betr || '',
            sleepr: platformNames.sleepr || '',
          });
        }
      }

      // Under edge
      if (prices.underPrice) {
        const bookProb = impliedProb(prices.underPrice);
        const edge = consensusUnderProb - bookProb;
        if (edge > 0.02) {
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
  }

  // Sort by edge descending (biggest edges first)
  allEdges.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge));
  console.log(`[props] Found ${allEdges.length} prop edges (2%+ threshold)`);

  // Write to Prop_Combos sheet
  const ts = new Date().toISOString();
  const outputRows = [['Timestamp', 'League', 'Player', 'Market', 'Line', 'Direction', 'Book', 'BookOdds', 'BookProb', 'ConsensusProb', 'Edge', 'Game', 'PrizePicks', 'Underdog', 'Betr', 'Sleepr']];
  for (const e of allEdges) {
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
    ]);
  }

  await clearSheet(SPREADSHEET_ID, COMBOS_SHEET);
  await setValues(SPREADSHEET_ID, COMBOS_SHEET, 'A1', outputRows);
  console.log(`[props] Wrote ${allEdges.length} prop edges to ${COMBOS_SHEET}`);
}

/**
 * Grade prop edges against actual player stats.
 * Reads Prop_Combos (today's edges), compares against actual performance,
 * writes results to Prop_Performance sheet to create feedback loop.
 * Trigger 8: ~11 PM ET daily (after games end).
 */
async function gradePropPicks() {
  console.log('[props] Grading prop edges...');
  const combos = await getValues(SPREADSHEET_ID, COMBOS_SHEET);
  if (!combos || combos.length < 2) {
    console.warn('[props] No prop edges to grade.');
    return;
  }

  const edges = combos.slice(1);
  // TODO: Fetch actual player stats from ESPN or stats API to compare against edges
  // For now, log what needs grading
  console.log(`[props] ${edges.length} prop edges pending grading.`);
  console.log('[props] Grading requires stats API integration — logging for manual review.');

  // Write a summary to Prop_Performance
  const perfSheet = SHEETS.PROP_PERFORMANCE || 'Prop_Performance';
  const ts = new Date().toISOString();
  const summaryRows = [['Timestamp', 'League', 'Player', 'Market', 'Line', 'Direction', 'Book', 'Edge', 'Actual', 'Result']];
  for (const row of edges) {
    summaryRows.push([
      ts,
      row[1] || '', // league
      row[2] || '', // player
      row[3] || '', // market
      row[4] || '', // line
      row[5] || '', // direction
      row[6] || '', // book
      row[10] || '', // edge
      'PENDING',     // actual - needs stats API
      'PENDING',     // result - needs comparison
    ]);
  }

  // Append rather than clear — keep history
  const existing = await getValues(SPREADSHEET_ID, perfSheet);
  if (!existing || existing.length === 0) {
    await setValues(SPREADSHEET_ID, perfSheet, 'A1', summaryRows);
  } else {
    // Append without header
    const appendRows = summaryRows.slice(1);
    const nextRow = existing.length + 1;
    await setValues(SPREADSHEET_ID, perfSheet, `A${nextRow}`, appendRows);
  }
  console.log(`[props] Wrote ${edges.length} edges to ${perfSheet} for grading.`);
}

module.exports = { updatePlayerProps, generatePropEdges, gradePropPicks };
