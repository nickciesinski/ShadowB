'use strict';
/**
 * player-tiers.js — Player Value Tier Calculations
 * Reads player stats for all 4 leagues and assigns tier ratings (S/A/B/C/D).
 * Writes results back to NBA Players sheet (Player Tiers alias).
 */
const { getValues, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

const TIER_THRESHOLDS = {
  S: 90,
  A: 75,
  B: 60,
  C: 45,
  D: 0,
};

/**
 * Compute a composite score (0–100) for a player row.
 * Column layout: Name, Team, stat1, stat2, stat3, stat4, form
 * Works across sports — the stat columns differ but the composite
 * still gives a reasonable relative ranking within each league.
 */
function computeScore(row) {
  const ppg  = parseFloat(row[2]) || 0;
  const rpg  = parseFloat(row[3]) || 0;
  const apg  = parseFloat(row[4]) || 0;
  const fg   = parseFloat(row[5]) || 0;
  const form = parseFloat(row[6]) || 0;
  return Math.min(100, (ppg * 1.5) + (rpg * 0.8) + (apg * 1.0) + (fg * 0.3) + (form * 2.0));
}

function assignTier(score) {
  for (const [tier, threshold] of Object.entries(TIER_THRESHOLDS)) {
    if (score >= threshold) return tier;
  }
  return 'D';
}

/**
 * Read player stats from all 4 leagues, calculate tiers, and write results.
 * Writes to NBA Players sheet (the PLAYER_TIERS alias) for backward compat.
 */
async function updatePlayerTiers() {
  const leagueSheets = [
    { league: 'NBA', sheet: SHEETS.NBA_PLAYERS },
    { league: 'MLB', sheet: SHEETS.MLB_PLAYERS },
    { league: 'NFL', sheet: SHEETS.NFL_PLAYERS },
    { league: 'NHL', sheet: SHEETS.NHL_PLAYERS },
  ];

  const allTierRows = [];

  for (const { league, sheet } of leagueSheets) {
    try {
      const statsRows = await getValues(SPREADSHEET_ID, sheet);
      if (!statsRows || statsRows.length < 2) continue;

      for (let i = 1; i < statsRows.length; i++) {
        const row = statsRows[i];
        const name = row[0] || '';
        const team = row[1] || '';
        const score = computeScore(row);
        const tier = assignTier(score);
        allTierRows.push([name, team, league, score.toFixed(1), tier]);
      }
    } catch (e) {
      console.warn(`[player-tiers] Could not read ${league} players:`, e.message);
    }
  }

  if (allTierRows.length === 0) {
    console.log('[player-tiers] No player stats found');
    return;
  }

  // Write to PLAYER_TIERS sheet (NBA Players alias)
  const values = [['Player', 'Team', 'League', 'Score', 'Tier'], ...allTierRows];
  await setValues(SPREADSHEET_ID, SHEETS.PLAYER_TIERS, 'A1', values);

  console.log(`[player-tiers] Updated ${allTierRows.length} player tiers across all leagues`);
}

/**
 * Read current tier assignments from the sheet.
 */
async function readPlayerTiers() {
  const rows = await getValues(SPREADSHEET_ID, SHEETS.PLAYER_TIERS);
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).map((row) => ({
    name:   row[0],
    team:   row[1],
    league: row[2],
    score:  parseFloat(row[3]),
    tier:   row[4],
  }));
}

module.exports = { updatePlayerTiers, readPlayerTiers };
