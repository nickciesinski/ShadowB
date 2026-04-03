'use strict';
/**
 * props.js — Player Props & Platform Prop Picks
 * Fetches player prop lines from the Odds API, then uses GPT to generate
 * over/under recommendations for platforms like PrizePicks and Betr.
 */
const OpenAI = require('openai');
const { getValues, setValues, clearSheet } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, OPENAI_API_KEY, SPORTS } = require('./config');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
 * Generate GPT-powered player prop picks for PrizePicks/Betr.
 * Reads the raw prop data, deduplicates to consensus lines,
 * then asks GPT to pick over/under with confidence for the best plays.
 * Trigger 7: 6:15 AM ET daily (replaces old platform combos).
 */
async function generatePropPicks() {
  console.log('[props] Generating player prop picks...');

  // Read raw props (written by updatePlayerProps in trigger6)
  const rawProps = await getValues(SPREADSHEET_ID, PROPS_SHEET);
  if (!rawProps || rawProps.length < 2) {
    console.warn(`[props] ⚠️ No prop data available at ${new Date().toISOString()}. Trigger6 may have failed or no games today.`);
    return;
  }

  const propRows = rawProps.slice(1);
  const consensus = buildPropConsensus(propRows);
  console.log(`[props] ${consensus.length} unique player+market combinations`);

  if (consensus.length === 0) {
    console.warn(`[props] ⚠️ Consensus building failed at ${new Date().toISOString()}. No valid prop combinations found.`);
    return;
  }

  // Build sport lookup from the league column (column 8 in propRows)
  const sportMap = {
    'NBA': 'NBA',
    'MLB': 'MLB',
    'NHL': 'NHL',
    'NFL': 'NFL',
  };

  // Group by sport for separate GPT calls (keeps context focused)
  const bySport = {};
  for (const prop of consensus) {
    // Find the original row to get the league (column 8)
    const originalRow = propRows.find(row =>
      row[3] === prop.player && row[7] === prop.market && row[6] === prop.line
    );
    const league = originalRow ? originalRow[8] : null;
    const sport = league && sportMap[league] ? sportMap[league] : 'NBA';

    if (!bySport[sport]) bySport[sport] = [];
    bySport[sport].push(prop);
  }

  const allPicks = [];

  for (const [sport, props] of Object.entries(bySport)) {
    // Limit to top 30 props per sport to stay within token limits
    const topProps = props.slice(0, 30);

    const propsContext = topProps.map(p =>
      `${p.player} | ${p.market} | Line: ${p.line} | Over ${p.overPrice} (${p.overImplied}% implied) | Under ${p.underPrice} (${p.underImplied}% implied) | Game: ${p.game}`
    ).join('\n');

    const prompt = `You are an expert player props analyst for sports betting platforms like PrizePicks and Betr. Your job is to find the best over/under plays.

${sport} Player Props — Consensus Lines:

${propsContext}

INSTRUCTIONS:
1. Analyze each player's prop line and determine whether Over or Under has better value.
2. Consider: player recent form, matchup difficulty, pace of play, and whether the line is set too high or too low.
3. Pick the BEST 5-8 plays from this list — the ones with the clearest edges.
4. For each pick, provide the player, market, your pick (over/under), the line, and confidence (1-10).
5. Focus on plays that would work on PrizePicks/Betr (player over/under format).

Format as JSON: {"picks": [{"player": "Player Name", "market": "player_points", "pick": "over", "line": "24.5", "confidence": 7, "rationale": "Averaging 28 PPG last 10, facing bottom-5 defense..."}]}`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });
      const parsed = JSON.parse(completion.choices[0].message.content);
      const picks = parsed.picks || parsed.recommendations || [];
      for (const p of picks) {
        allPicks.push({ ...p, sport });
      }
      console.log(`[props] ${sport}: ${picks.length} prop picks generated`);
    } catch (err) {
      console.error(`[props] GPT error for ${sport} props:`, err.message);
    }
  }

  // Write picks to Prop_Combos sheet (repurposed for prop picks)
  const ts = new Date().toISOString();
  const outputRows = [['Timestamp', 'Sport', 'Player', 'Market', 'PrizePicks', 'Underdog', 'Betr', 'Sleepr', 'Pick', 'Line', 'Confidence', 'Rationale']];
  for (const p of allPicks) {
    const platformNames = PLATFORM_MARKETS[p.market] || {};
    outputRows.push([
      ts,
      p.sport || '',
      p.player || '',
      p.market || '',
      platformNames.prizepicks || '',
      platformNames.underdog || '',
      platformNames.betr || '',
      platformNames.sleepr || '',
      p.pick || '',
      p.line || '',
      p.confidence || '',
      p.rationale || '',
    ]);
  }

  await clearSheet(SPREADSHEET_ID, COMBOS_SHEET);
  await setValues(SPREADSHEET_ID, COMBOS_SHEET, 'A1', outputRows);
  console.log(`[props] Wrote ${allPicks.length} prop picks to ${COMBOS_SHEET}`);
}

/**
 * Grade prop picks against actual player stats.
 * Reads Prop_Combos (today's picks), compares against actual performance,
 * writes results to Prop_Performance sheet to create feedback loop.
 * Trigger 8: ~11 PM ET daily (after games end).
 */
async function gradePropPicks() {
  console.log('[props] Grading prop picks...');
  const combos = await getValues(SPREADSHEET_ID, COMBOS_SHEET);
  if (!combos || combos.length < 2) {
    console.warn('[props] No prop picks to grade.');
    return;
  }

  const picks = combos.slice(1);
  // TODO: Fetch actual player stats from ESPN or stats API to compare against picks
  // For now, log what needs grading
  console.log(`[props] ${picks.length} prop picks pending grading.`);
  console.log('[props] Grading requires stats API integration — logging for manual review.');

  // Write a summary to Prop_Performance
  const perfSheet = SHEETS.PROP_PERFORMANCE || 'Prop_Performance';
  const ts = new Date().toISOString();
  const summaryRows = [['Timestamp', 'Sport', 'Player', 'Market', 'Pick', 'Line', 'Confidence', 'Actual', 'Result']];
  for (const row of picks) {
    summaryRows.push([
      ts,
      row[1] || '', // sport
      row[2] || '', // player
      row[3] || '', // market
      row[8] || '', // pick
      row[9] || '', // line
      row[10] || '', // confidence
      'PENDING',    // actual - needs stats API
      'PENDING',    // result - needs comparison
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
  console.log(`[props] Wrote ${picks.length} picks to ${perfSheet} for grading.`);
}

module.exports = { updatePlayerProps, generatePropPicks, gradePropPicks };
