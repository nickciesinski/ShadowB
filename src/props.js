'use strict';
/**
 * props.js — Player Props & Platform Combos
 * Fetches player prop lines from the Odds API and writes suggested
 * prop bets + multi-platform combo recommendations to the Props sheet.
 */
const fetch = require('node-fetch');
const { sheetsApi } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, SPORTS } = require('./config');

const PROPS_SHEET   = SHEETS.PLAYER_PROPS;   // 'Player Props'
const COMBOS_SHEET  = SHEETS.PLATFORM_COMBOS; // 'Platform Combos'

/**
 * Fetch player prop odds from The Odds API for a given sport and market.
 * @param {string} sport  - e.g. 'basketball_nba'
 * @param {string} market - e.g. 'player_points', 'player_rebounds'
 */
async function fetchPropOdds(sport, market) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${ODDS_API_KEY}&regions=us&markets=${market}&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API error ${res.status} for ${market}`);
  return res.json();
}

/**
 * Parse raw event data into flat prop rows for writing to Sheets.
 */
function parseProps(events, market) {
  const rows = [];
  for (const event of events) {
    const gameLabel = `${event.home_team} vs ${event.away_team}`;
    const commence  = event.commence_time;
    for (const bm of (event.bookmakers || [])) {
      for (const mkt of (bm.markets || [])) {
        if (mkt.key !== market) continue;
        for (const outcome of mkt.outcomes) {
          rows.push([
            gameLabel,
            commence,
            bm.title,
            outcome.name,
            outcome.description || '',
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
 * Update the Player Props sheet with fresh prop lines.
 */
async function updatePlayerProps() {
  const sheets = await sheetsApi();
  const markets = ['player_points', 'player_rebounds', 'player_assists', 'player_threes'];
  let allRows = [['Game', 'Time', 'Book', 'Player', 'Description', 'Price', 'Line', 'Market']];

  for (const sport of SPORTS) {
    for (const market of markets) {
      try {
        const events = await fetchPropOdds(sport, market);
        const rows = parseProps(events, market);
        allRows = allRows.concat(rows);
      } catch (err) {
        console.warn(`[props] Failed ${sport}/${market}:`, err.message);
      }
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PROPS_SHEET}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: allRows },
  });
  console.log(`[props] Wrote ${allRows.length - 1} prop rows`);
}

/**
 * Build platform combo recommendations based on current prop lines.
 * Looks for same-player props available across multiple books with +EV lines.
 */
async function updatePlatformCombos() {
  const sheets = await sheetsApi();
  // Read existing props
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PROPS_SHEET}!A2:H`,
  });
  const rows = resp.data.values || [];

  // Group by player + market
  const grouped = {};
  for (const row of rows) {
    const key = `${row[3]}|${row[7]}`; // player|market
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ book: row[2], price: parseInt(row[5]), line: row[6] });
  }

  // Find combos where multiple books offer the same side
  const comboRows = [['Player/Market', 'Books', 'Best Price', 'Line', 'Combo Value']];
  for (const [key, entries] of Object.entries(grouped)) {
    if (entries.length < 2) continue;
    const sorted = entries.sort((a, b) => b.price - a.price);
    const bestPrice = sorted[0].price;
    const books = sorted.slice(0, 3).map(e => e.book).join(' + ');
    comboRows.push([key, books, bestPrice, sorted[0].line, 'Review']);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${COMBOS_SHEET}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: comboRows },
  });
  console.log(`[props] Wrote ${comboRows.length - 1} combo recommendations`);
}

module.exports = { updatePlayerProps, updatePlatformCombos };
