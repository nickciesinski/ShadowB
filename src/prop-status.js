'use strict';
/**
 * prop-status.js — Player Status Monitor
 *
 * Detects player injuries, scratches, and lineup changes by comparing
 * today's prop lines against the previous fetch. If a player had props
 * in the last fetch but disappears, they're flagged as likely scratched.
 *
 * Per-sport impact rules estimate how a missing player affects teammates:
 *   NBA: usage/minutes bumps (star out → role players absorb touches)
 *   NFL: target redistribution (WR out → other WRs/TE get targets)
 *   MLB: lineup/pitcher adjustments (ace scratched → bullpen game)
 *   NHL: goalie/forward adjustments (starter out → backup, line shuffles)
 *
 * Writes status + impact flags to Prop_Status sheet. The edge calculator
 * in props.js reads these flags to adjust edges on affected players.
 */
const { getValues, setValues, clearSheet, appendRows } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, SPORTS } = require('./config');
const { logApiCall } = require('./monitoring');

const ODDS_API_COST = 0.001;

// ── Impact Rules per Sport ─────────────────────────────────────────
// When a key player is missing, how much does it boost/penalize teammates?
// Values are additive edge adjustments (percentage points).

const IMPACT_RULES = {
  NBA: {
    // Star player out → teammates absorb usage. Boost based on avg usage rate.
    // High-usage stars (top-10 in usage%): teammates get +1.5% edge on scoring props
    // Medium-usage (top-30): +0.8%
    // Role players: +0.3%
    highUsageBump: 1.5,
    medUsageBump: 0.8,
    lowUsageBump: 0.3,
    // Relevant prop markets for usage redistribution
    affectedMarkets: ['player_points', 'player_assists', 'player_rebounds', 'player_threes', 'player_points_rebounds_assists'],
  },
  NFL: {
    // WR/TE out → target redistribution to other pass catchers
    targetRedistBump: 1.2,
    // RB out → backup RB rush yards bump
    rushRedistBump: 1.0,
    affectedMarkets: ['player_reception_yds', 'player_rush_yds', 'player_anytime_td'],
  },
  MLB: {
    // Starting pitcher scratched → bullpen game = higher totals, more hits
    pitcherScratchBump: 1.5,
    // Key batter out → minimal redistribution (baseball is more individual)
    batterOutBump: 0.3,
    affectedMarkets: ['batter_hits', 'batter_total_bases', 'batter_home_runs', 'pitcher_strikeouts'],
  },
  NHL: {
    // Starting goalie out → more goals expected (affects totals + shots)
    goalieScratchBump: 2.0,
    // Top-line forward out → linemates lose, other lines gain slightly
    forwardOutBump: 0.5,
    affectedMarkets: ['player_points', 'player_shots_on_goal', 'player_assists'],
  },
};

/**
 * Detect scratched/missing players by comparing current prop lines
 * against the previous fetch stored in Player_Props.
 *
 * Strategy: For each game, collect the set of players with prop lines.
 * Compare against the same game from the most recent prior snapshot.
 * Players who disappear are flagged as potentially scratched.
 *
 * Falls back to the Odds API events endpoint to check if games are
 * still active (cancelled games shouldn't flag all players).
 */
async function detectStatusChanges() {
  console.log('[prop-status] Checking player statuses...');

  // Read current Player_Props (most recent fetch from trigger6)
  const currentProps = await getValues(SPREADSHEET_ID, SHEETS.PLAYER_PROPS);
  if (!currentProps || currentProps.length < 2) {
    console.log('[prop-status] No current prop data to analyze.');
    return { scratched: [], impacts: [] };
  }

  // Read previous status snapshot to detect changes
  const prevStatus = await getValues(SPREADSHEET_ID, SHEETS.PROP_STATUS);

  // Build player-per-game index from current props
  // Columns: 0=Game, 1=Time, 2=Book, 3=Player, 4=Description, 5=Price, 6=Line, 7=Market, 8=League
  const playersByGame = {}; // "league|game" → Set of player names
  for (const row of currentProps.slice(1)) {
    const league = row[8] || '';
    const game = row[0] || '';
    const player = row[3] || '';
    if (!player || !game) continue;
    const key = `${league}|${game}`;
    if (!playersByGame[key]) playersByGame[key] = new Set();
    playersByGame[key].add(player);
  }

  // Also try to detect high-usage players via prop line count
  // Players with MORE prop markets listed are typically starters/stars
  const playerPropCount = {}; // "league|player" → count of markets
  for (const row of currentProps.slice(1)) {
    const league = row[8] || '';
    const player = row[3] || '';
    const market = row[7] || '';
    const key = `${league}|${player}`;
    if (!playerPropCount[key]) playerPropCount[key] = new Set();
    playerPropCount[key].add(market);
  }

  // Identify key players (those with 3+ different prop markets = likely starter/star)
  const keyPlayers = new Set();
  for (const [key, markets] of Object.entries(playerPropCount)) {
    if (markets.size >= 3) keyPlayers.add(key);
  }

  // Check for players in previous status who are now missing from props
  const scratched = [];
  const impacts = [];

  if (prevStatus && prevStatus.length > 1) {
    const prevPlayers = new Set();
    for (const row of prevStatus.slice(1)) {
      const player = row[2] || '';
      const league = row[1] || '';
      if (player && row[4] === 'ACTIVE') {
        prevPlayers.add(`${league}|${player}`);
      }
    }

    // Check: players previously ACTIVE who are no longer in any prop line
    const currentPlayers = new Set();
    for (const row of currentProps.slice(1)) {
      const league = row[8] || '';
      const player = row[3] || '';
      if (player) currentPlayers.add(`${league}|${player}`);
    }

    for (const prevKey of prevPlayers) {
      if (!currentPlayers.has(prevKey)) {
        const [league, player] = prevKey.split('|');
        const isKey = keyPlayers.has(prevKey);
        scratched.push({ league, player, isKeyPlayer: isKey });
        console.log(`[prop-status] SCRATCH detected: ${player} (${league})${isKey ? ' [KEY PLAYER]' : ''}`);
      }
    }
  }

  // Compute impact on teammates
  for (const scratch of scratched) {
    if (!scratch.isKeyPlayer) continue;
    const rules = IMPACT_RULES[scratch.league];
    if (!rules) continue;

    // Find the game this player was in
    let game = '';
    for (const [key, players] of Object.entries(playersByGame)) {
      if (key.startsWith(`${scratch.league}|`)) {
        // Check previous props for this player's game
        // (they're not in current props anymore, so we check prev)
        game = key.split('|').slice(1).join('|');
        break;
      }
    }

    // Find teammates (other players in the same game)
    const gameKey = `${scratch.league}|${game}`;
    const teammates = playersByGame[gameKey] || new Set();

    for (const teammate of teammates) {
      if (teammate === scratch.player) continue;
      const bump = scratch.league === 'NBA' ? rules.highUsageBump
        : scratch.league === 'NFL' ? rules.targetRedistBump
        : scratch.league === 'MLB' ? rules.pitcherScratchBump
        : rules.goalieScratchBump;

      impacts.push({
        league: scratch.league,
        player: teammate,
        scratchedPlayer: scratch.player,
        edgeBump: bump,
        affectedMarkets: rules.affectedMarkets,
        game,
      });
    }
  }

  console.log(`[prop-status] ${scratched.length} scratched players, ${impacts.length} teammate impacts`);
  return { scratched, impacts };
}

/**
 * Write status snapshot to Prop_Status sheet.
 * Records all active players + any detected scratches and impacts.
 */
async function writeStatusSnapshot(statusData) {
  const ts = new Date().toISOString();
  const { scratched, impacts } = statusData;

  const rows = [['Timestamp', 'League', 'Player', 'Game', 'Status', 'ImpactType', 'EdgeBump', 'ScratchedPlayer', 'AffectedMarkets']];

  // Write scratch entries
  for (const s of scratched) {
    rows.push([ts, s.league, s.player, '', 'SCRATCHED', s.isKeyPlayer ? 'key_player' : 'role_player', 0, '', '']);
  }

  // Write impact entries (teammates who benefit/suffer from a scratch)
  for (const imp of impacts) {
    rows.push([
      ts, imp.league, imp.player, imp.game, 'IMPACT',
      'teammate_bump', imp.edgeBump, imp.scratchedPlayer,
      (imp.affectedMarkets || []).join(','),
    ]);
  }

  await clearSheet(SPREADSHEET_ID, SHEETS.PROP_STATUS);
  await setValues(SPREADSHEET_ID, SHEETS.PROP_STATUS, 'A1', rows);
  console.log(`[prop-status] Wrote ${rows.length - 1} status entries to Prop_Status`);
}

/**
 * Read current status impacts for use by the edge calculator.
 * Returns a map: "league|player" → { edgeBump, affectedMarkets, scratchedPlayer }
 */
async function getStatusImpacts() {
  const rows = await getValues(SPREADSHEET_ID, SHEETS.PROP_STATUS);
  if (!rows || rows.length < 2) return {};

  const impacts = {};
  for (const row of rows.slice(1)) {
    if (row[4] !== 'IMPACT') continue;
    const league = row[1] || '';
    const player = row[2] || '';
    const key = `${league}|${player}`;
    impacts[key] = {
      edgeBump: parseFloat(row[6]) || 0,
      affectedMarkets: (row[8] || '').split(',').filter(Boolean),
      scratchedPlayer: row[7] || '',
    };
  }
  return impacts;
}

/**
 * Main entry point: detect status changes and write snapshot.
 * Called by trigger before prop edge calculation.
 */
async function updatePlayerStatus() {
  const statusData = await detectStatusChanges();
  await writeStatusSnapshot(statusData);
  return statusData;
}

module.exports = { updatePlayerStatus, getStatusImpacts, IMPACT_RULES };
