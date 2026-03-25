'use strict';
/**
 * player-tiers.js — Player Value Tier Calculations
 * Reads player stats and assigns tier ratings (S/A/B/C/D) to the Player Tiers sheet.
 */
const { getValues, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

const TIERS_SHEET = SHEETS.PLAYER_TIERS;      // 'NBA Players' (aliased in config)
const STATS_SHEET = SHEETS.PLAYER_STATS;       // 'NBA Players' (aliased in config)

const TIER_THRESHOLDS = {
  S: 90,
  A: 75,
  B: 60,
  C: 45,
  D: 0,
};

/**
 * Compute a composite score (0–100) for a player row.
 * Adjust column indices to match your actual sheet layout.
 */
function computeScore(row) {
  const ppg  = parseFloat(row[2]) || 0;  // Points per game
  const rpg  = parseFloat(row[3]) || 0;  // Rebounds per game
  const apg  = parseFloat(row[4]) || 0;  // Assists per game
  const fg   = parseFloat(row[5]) || 0;  // FG%
  const form = parseFloat(row[6]) || 0;  // Recent form score (0–10)
  // Weighted composite — tune these coefficients as needed
  return Math.min(100, (ppg * 1.5) + (rpg * 0.8) + (apg * 1.0) + (fg * 0.3) + (form * 2.0));
}

function assignTier(score) {
  for (const [tier, threshold] of Object.entries(TIER_THRESHOLDS)) {
    if (score >= threshold) return tier;
  }
  return 'D';
}

/**
 * Read player stats, calculate tiers, and write results back to the Player Tiers sheet.
 */
async function updatePlayerTiers() {
  const statsRows = await getValues(SPREADSHEET_ID, STATS_SHEET);
  if (!statsRows || statsRows.length < 2) {
    console.log('[player-tiers] No player stats found');
    return;
  }

  const dataRows = statsRows.slice(1);

  const tierRows = dataRows.map((row) => {
    const name  = row[0] || '';
    const team  = row[1] || '';
    const score = computeScore(row);
    const tier  = assignTier(score);
    return [name, team, score.toFixed(1), tier];
  });

  const values = [['Player', 'Team', 'Score', 'Tier'], ...tierRows];
  await setValues(SPREADSHEET_ID, TIERS_SHEET, 'A1', values);

  console.log(`[player-tiers] Updated ${tierRows.length} player tiers`);
}

/**
 * Read current tier assignments from the sheet.
 */
async function readPlayerTiers() {
  const rows = await getValues(SPREADSHEET_ID, TIERS_SHEET);
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).map((row) => ({
    name:  row[0],
    team:  row[1],
    score: parseFloat(row[2]),
    tier:  row[3],
  }));
}

module.exports = { updatePlayerTiers, readPlayerTiers };
