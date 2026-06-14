'use strict';
/**
 * player-tiers.js — Player Value Tier Calculations
 * 
 * Reads player rosters + stats (Name, Team, League, Position, ESPN_ID, Jersey, ...stats)
 * and Prop_Performance data to assign tier ratings (S/A/B/C/D).
 * 
 * Tier logic (3 signals, weighted):
 *   - Real performance stats from ESPN leaders (cols 6+) → up to +30 boost
 *   - Prop market frequency (many markets, many appearances) → up to +35 boost
 *   - Key positions (QB, SP/CP, G for NHL) → base score 30-90
 *   - Any player appearing in ESPN leaders gets a minimum B-tier floor
 */
const { getValues, setValues, clearSheet, ensureSheet } = require('./sheets');
const db = require('./db');
const { dataModeFor } = require('./config');
const dataStore = require('./data-store');
const { SPREADSHEET_ID, SHEETS } = require('./config');

// Position importance by sport (higher = more impactful when injured)
const POSITION_WEIGHTS = {
  // MLB: Starting pitchers are most impactful
  SP: 85, CP: 70, RP: 40, C: 50, '1B': 45, '2B': 45, SS: 50, '3B': 45, LF: 40, CF: 45, RF: 40, DH: 35, OF: 40,
  // NBA: Stars play 30+ min regardless of position
  PG: 55, SG: 50, SF: 50, PF: 50, 'C-NBA': 50,
  // NHL: Goalies are most impactful
  G: 85, D: 50, LW: 45, RW: 45, 'C-NHL': 50,
  // NFL: QB is by far most impactful
  QB: 90, RB: 55, WR: 50, TE: 45, OL: 40, DL: 40, LB: 45, CB: 45, S: 40, K: 35, P: 30,
};

function getPositionWeight(pos, league) {
  if (!pos) return 30;
  const p = pos.toUpperCase();
  // Handle ambiguous positions (C in NHL vs MLB vs NBA)
  if (p === 'C') {
    if (league === 'NHL') return POSITION_WEIGHTS['C-NHL'] || 50;
    if (league === 'NBA') return POSITION_WEIGHTS['C-NBA'] || 50;
    return POSITION_WEIGHTS['C'] || 50; // MLB catcher
  }
  return POSITION_WEIGHTS[p] || 30;
}

function assignTier(score) {
  if (score >= 85) return 'S';
  if (score >= 70) return 'A';
  if (score >= 50) return 'B';
  if (score >= 30) return 'C';
  return 'D';
}

/**
 * Read player rosters + prop performance data to calculate tiers.
 * Players who appear in more prop markets with better results get higher tiers.
 */
async function updatePlayerTiers() {
  const leagueSheets = [
    { league: 'NBA', sheet: SHEETS.NBA_PLAYERS },
    { league: 'MLB', sheet: SHEETS.MLB_PLAYERS },
    { league: 'NFL', sheet: SHEETS.NFL_PLAYERS },
    { league: 'NHL', sheet: SHEETS.NHL_PLAYERS },
  ];

  // Build prop frequency map: player name → market count from Prop_Performance
  const propFreq = {};
  try {
    const propRows = await getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE);
    if (propRows && propRows.length > 1) {
      for (let i = 1; i < propRows.length; i++) {
        const player = (propRows[i][2] || '').trim(); // Column C = player name
        const market = (propRows[i][3] || '').trim(); // Column D = market
        if (!player) continue;
        if (!propFreq[player]) propFreq[player] = { markets: new Set(), appearances: 0 };
        propFreq[player].markets.add(market);
        propFreq[player].appearances++;
      }
    }
  } catch (e) {
    console.warn('[player-tiers] Could not read Prop_Performance:', e.message);
  }

  const allTierRows = [];

  for (const { league, sheet } of leagueSheets) {
    try {
      const rows = await getValues(SPREADSHEET_ID, sheet);
      if (!rows || rows.length < 2) continue;

      // New schema: Name(0), Team(1), League(2), Position(3), ESPN_ID(4), Jersey(5)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const name = (row[0] || '').trim();
        const team = (row[1] || '').trim();
        const pos = (row[3] || '').trim();
        if (!name) continue;

        // Base score from position importance
        let score = getPositionWeight(pos, league);

        // Boost from real performance stats (columns 6+ from ESPN leaders)
        const hasStats = row.length > 6 && row.slice(6).some(v => v !== '' && v !== undefined);
        if (hasStats) {
          // Players with actual ESPN leader stats are at least moderately important
          const statCount = row.slice(6).filter(v => v !== '' && v !== undefined && v !== null).length;
          // More stat categories present = more well-rounded player
          score += Math.min(statCount * 4, 30); // up to +30 for appearing in 7+ stat categories
          // Floor: any player in ESPN leaders is at least B-tier material
          score = Math.max(score, 50);
        }

        // Boost from prop market frequency (indicates star player)
        const freq = propFreq[name];
        if (freq) {
          const marketCount = freq.markets.size;
          const appearances = freq.appearances;
          // More unique markets = more well-rounded star
          score += Math.min(marketCount * 5, 20); // up to +20 for 4+ markets
          // More appearances = more consistently featured
          score += Math.min(appearances * 0.5, 15); // up to +15 for 30+ appearances
        }

        score = Math.min(100, score);
        const tier = assignTier(score);
        allTierRows.push([name, team, league, score.toFixed(1), tier]);
      }
    } catch (e) {
      console.warn(`[player-tiers] Could not read ${league} players:`, e.message);
    }
  }

  if (allTierRows.length === 0) {
    console.log('[player-tiers] No player data found');
    return;
  }

  // Write to PLAYER_TIERS sheet (auto-create if missing)
  const values = [['Player', 'Team', 'League', 'Score', 'Tier'], ...allTierRows];
  await ensureSheet(SPREADSHEET_ID, SHEETS.PLAYER_TIERS);
  await clearSheet(SPREADSHEET_ID, SHEETS.PLAYER_TIERS);
  await setValues(SPREADSHEET_ID, SHEETS.PLAYER_TIERS, 'A1', values);
  if (dataModeFor('playerTiers') !== 'sheet') {
    try { await db.insertSnapshot('playerTiers', values); }
    catch (e) { console.warn('[player-tiers] playerTiers snapshot dual-write failed:', e.message); }
  }

  const tierCounts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const [, , , , t] of allTierRows) tierCounts[t]++;
  console.log(`[player-tiers] Updated ${allTierRows.length} tiers — S:${tierCounts.S} A:${tierCounts.A} B:${tierCounts.B} C:${tierCounts.C} D:${tierCounts.D}`);
}

/**
 * Read current tier assignments from the sheet.
 */
async function readPlayerTiers() {
  const rows = await dataStore.read('playerTiers');
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
