'use strict';
// =============================================================
// src/data-collection.js — ESPN + Odds API fetching & grading
// Replaces: Data Collection (Apps Script)
// =============================================================

const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, ODDS_API_BASE, SPORTS, MARKETS } = require('./config');
const { getValues, setValues, appendRows, clearSheet } = require('./sheets');

// ── ESPN API ────────────────────────────────────────────────────

/**
 * Fetch player stats from ESPN API and write to PlayerStats sheet.
 * Trigger 1: 3:30 AM ET daily (trigger1)
 */
async function updatePlayerStats() {
  console.log('[data-collection] Updating player stats from ESPN...');
  
  const sports = [
    { key: 'baseball', league: 'mlb' },
    { key: 'basketball', league: 'nba' },
  ];

  const allRows = [['Timestamp', 'Sport', 'PlayerName', 'Team', 'Position', 'Stat', 'Value']];

  for (const { key, league } of sports) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/${league}/athletes`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { console.warn(`ESPN ${league} returned ${res.status}`); continue; }
      const data = await res.json();
      const athletes = data.athletes || [];
      const ts = new Date().toISOString();
      for (const athlete of athletes.slice(0, 200)) {
        const name = athlete.displayName || athlete.fullName || '';
        const team = athlete.team?.abbreviation || '';
        const pos  = athlete.position?.abbreviation || '';
        allRows.push([ts, league.toUpperCase(), name, team, pos, 'active', '1']);
      }
    } catch (err) {
      console.error(`[data-collection] ESPN ${league} error:`, err.message);
    }
  }

  await clearSheet(SPREADSHEET_ID, SHEETS.PLAYER_STATS);
  await setValues(SPREADSHEET_ID, SHEETS.PLAYER_STATS, 'A1', allRows);
  console.log(`[data-collection] Player stats updated: ${allRows.length - 1} rows`);
}

/**
 * Fetch team stats from ESPN API and write to TeamStats sheet.
 * Trigger 2: 4:00 AM ET daily (trigger2)
 */
async function updateTeamStats() {
  console.log('[data-collection] Updating team stats from ESPN...');
  
  const sports = [
    { key: 'baseball', league: 'mlb' },
    { key: 'basketball', league: 'nba' },
    { key: 'football', league: 'nfl' },
  ];

  const allRows = [['Timestamp', 'Sport', 'Team', 'Abbreviation', 'Win', 'Loss', 'WinPct']];
  const ts = new Date().toISOString();

  for (const { key, league } of sports) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/${league}/teams`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { console.warn(`ESPN teams ${league} returned ${res.status}`); continue; }
      const data = await res.json();
      const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];
      for (const { team } of teams) {
        const record = team.record?.items?.[0]?.summary || '0-0';
        const [w, l] = record.split('-').map(Number);
        const pct = w + l > 0 ? (w / (w + l)).toFixed(3) : '0.000';
        allRows.push([ts, league.toUpperCase(), team.displayName, team.abbreviation, w || 0, l || 0, pct]);
      }
    } catch (err) {
      console.error(`[data-collection] ESPN teams ${league} error:`, err.message);
    }
  }

  await clearSheet(SPREADSHEET_ID, SHEETS.TEAM_STATS);
  await setValues(SPREADSHEET_ID, SHEETS.TEAM_STATS, 'A1', allRows);
  console.log(`[data-collection] Team stats updated: ${allRows.length - 1} rows`);
}

// ── Odds API ────────────────────────────────────────────────────

/**
 * Fetch odds from The Odds API and write to GameOdds sheet.
 * Also archives to HistoricalOdds. Used by trigger3.
 */
async function fetchOddsAndGrade() {
  console.log('[data-collection] Fetching odds + grading yesterday...');
  
  const allOddsRows = [['Timestamp', 'Sport', 'HomeTeam', 'AwayTeam', 'CommenceTime', 'Market', 'Outcome', 'Price', 'Point', 'BookmakerKey']];
  const ts = new Date().toISOString();

  for (const [sportName, sportConfig] of Object.entries(SPORTS)) {
    try {
      const params = new URLSearchParams({
        apiKey: ODDS_API_KEY,
        regions: 'us',
        markets: MARKETS.join(','),
        oddsFormat: 'american',
      });
      const url = `${ODDS_API_BASE}/sports/${sportConfig.key}/odds?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { console.warn(`Odds API ${sportName}: ${res.status}`); continue; }
      const events = await res.json();

      for (const event of events) {
        for (const bookmaker of event.bookmakers || []) {
          for (const market of bookmaker.markets || []) {
            for (const outcome of market.outcomes || []) {
              allOddsRows.push([
                ts, sportName,
                event.home_team, event.away_team,
                event.commence_time,
                market.key, outcome.name,
                outcome.price, outcome.point || '',
                bookmaker.key,
              ]);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[data-collection] Odds API ${sportName} error:`, err.message);
    }
  }

  await clearSheet(SPREADSHEET_ID, SHEETS.GAME_ODDS);
  await setValues(SPREADSHEET_ID, SHEETS.GAME_ODDS, 'A1', allOddsRows);
  
  // Archive to historical (append only)
  if (allOddsRows.length > 1) {
    await appendRows(SPREADSHEET_ID, SHEETS.HISTORICAL_ODDS, allOddsRows.slice(1));
  }
  
  console.log(`[data-collection] Odds updated: ${allOddsRows.length - 1} rows`);
}

// ── Yesterday's Results (Scores API) ─────────────────────────

/**
 * Fetch yesterday's completed game scores from The Odds API.
 * Writes to Yesterday_Results sheet for grading.
 * Used by trigger12 (post-game grading).
 */
async function fetchYesterdayResults() {
  console.log('[data-collection] Fetching yesterday\'s game results...');

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD

  const allRows = [['League', 'GameDate', 'AwayTeam', 'HomeTeam', 'AwayScore', 'HomeScore', 'Status']];

  for (const [sportName, sportConfig] of Object.entries(SPORTS)) {
    try {
      const params = new URLSearchParams({
        apiKey: ODDS_API_KEY,
        daysFrom: '1',
      });
      const url = `${ODDS_API_BASE}/sports/${sportConfig.key}/scores?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { console.warn(`Scores API ${sportName}: ${res.status}`); continue; }
      const games = await res.json();

      for (const game of games) {
        if (!game.completed) continue;

        // Check if the game was yesterday
        const gameDate = (game.commence_time || '').split('T')[0];
        if (gameDate !== yesterdayStr) continue;

        // Extract scores — scores array has { name, score } for each team
        const scores = game.scores || [];
        const homeData = scores.find(s => s.name === game.home_team) || {};
        const awayData = scores.find(s => s.name === game.away_team) || {};

        allRows.push([
          sportName,
          game.commence_time || '',
          game.away_team || '',
          game.home_team || '',
          parseFloat(awayData.score) || 0,
          parseFloat(homeData.score) || 0,
          'Final',
        ]);
      }
      console.log(`[data-collection] ${sportName}: found scores for ${allRows.length - 1} completed games`);
    } catch (err) {
      console.error(`[data-collection] Scores API ${sportName} error:`, err.message);
    }
  }

  await clearSheet(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS);
  await setValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS, 'A1', allRows);
  console.log(`[data-collection] Yesterday results updated: ${allRows.length - 1} games`);
  return allRows.length - 1;
}

module.exports = {
  updatePlayerStats,
  updateTeamStats,
  fetchOddsAndGrade,
  fetchYesterdayResults,
};
