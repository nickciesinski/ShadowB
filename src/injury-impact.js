'use strict';
/**
 * src/injury-impact.js — Player-level injury impact for game predictions
 *
 * Reads Prop_Status (scratched players) and Injury Summary sheet,
 * cross-references with player stats sheets to determine each player's
 * team and importance tier, then computes per-team injury severity scores.
 *
 * Score meaning:
 *   0.0 = healthy roster, no significant injuries
 *   0.3 = minor injuries (role players out)
 *   0.5 = moderate (one starter out)
 *   0.7 = significant (key starter out)
 *   1.0 = devastating (multiple starters or MVP-caliber player out)
 */
const { getValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

// ── Module cache (loaded once per trigger run) ─────────────────
let _teamInjuries = null; // { "NBA|BOS": 0.3, "NHL|TOR": 0.7, ... }

// Tier-based severity weights — S-tier players being out hurts much more
const TIER_SEVERITY = {
  S: 0.50,
  A: 0.35,
  B: 0.20,
  C: 0.10,
  D: 0.05,
};

// Status-based multipliers — "out" is worse than "questionable"
const STATUS_MULTIPLIER = {
  out: 1.0,
  o: 1.0,
  scratched: 1.0,
  suspended: 1.0,
  doubtful: 0.75,
  d: 0.75,
  questionable: 0.40,
  q: 0.40,
  'day-to-day': 0.30,
  dtd: 0.30,
  probable: 0.10,
  p: 0.10,
};

/**
 * Build a player name → { team, league, tier } lookup from all 4 league player sheets.
 * Uses the same scoring logic as player-tiers.js but works across all leagues.
 */
async function buildPlayerLookup() {
  const lookup = {}; // normalized name → { team, league, tier, score }

  const leagueSheets = [
    { league: 'NBA', sheet: SHEETS.NBA_PLAYERS },
    { league: 'MLB', sheet: SHEETS.MLB_PLAYERS },
    { league: 'NFL', sheet: SHEETS.NFL_PLAYERS },
    { league: 'NHL', sheet: SHEETS.NHL_PLAYERS },
  ];

  for (const { league, sheet } of leagueSheets) {
    try {
      const rows = await getValues(SPREADSHEET_ID, sheet);
      if (!rows || rows.length < 2) continue;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const name = (row[0] || '').trim();
        const team = (row[1] || '').trim().toUpperCase();
        if (!name || !team) continue;

        // Compute simple composite score for tier assignment
        const ppg  = parseFloat(row[2]) || 0;
        const rpg  = parseFloat(row[3]) || 0;
        const apg  = parseFloat(row[4]) || 0;
        const fg   = parseFloat(row[5]) || 0;
        const form = parseFloat(row[6]) || 0;
        const score = Math.min(100, (ppg * 1.5) + (rpg * 0.8) + (apg * 1.0) + (fg * 0.3) + (form * 2.0));

        let tier = 'D';
        if (score >= 90) tier = 'S';
        else if (score >= 75) tier = 'A';
        else if (score >= 60) tier = 'B';
        else if (score >= 45) tier = 'C';

        const normName = name.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        lookup[`${league}|${normName}`] = { team, league, tier, score };
      }
    } catch (e) {
      console.warn(`[injury-impact] Could not read ${league} players:`, e.message);
    }
  }

  return lookup;
}

/**
 * Normalize a player name for fuzzy matching
 */
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
}

/**
 * Look up a player in the roster. Tries exact match first, then partial.
 */
function findPlayer(lookup, league, playerName) {
  const norm = normalizeName(playerName);
  if (!norm) return null;

  // Exact match
  const exact = lookup[`${league}|${norm}`];
  if (exact) return exact;

  // Try all leagues if league is ambiguous
  if (!league) {
    for (const key of Object.keys(lookup)) {
      if (key.endsWith(`|${norm}`)) return lookup[key];
    }
  }

  // Partial match — last name only (handles "J. Smith" vs "John Smith")
  const parts = norm.split(/\s+/);
  const lastName = parts[parts.length - 1];
  if (lastName.length >= 3) {
    const prefix = league ? `${league}|` : '';
    for (const [key, val] of Object.entries(lookup)) {
      if (prefix && !key.startsWith(prefix)) continue;
      if (key.endsWith(` ${lastName}`)) return val;
    }
  }

  return null;
}

/**
 * Load injury data from Prop_Status + Injury Summary and compute
 * per-team severity scores weighted by player tier.
 *
 * @returns {Object} Map of "league|teamAbbr" → severity (0-1)
 */
async function loadInjuryImpact() {
  if (_teamInjuries) return _teamInjuries;
  _teamInjuries = {};

  // Build player lookup from all 4 league stat sheets
  const playerLookup = await buildPlayerLookup();
  const lookupSize = Object.keys(playerLookup).length;
  if (lookupSize > 0) {
    console.log(`[injury-impact] Built player lookup: ${lookupSize} players across all leagues`);
  }

  // Source 1: Prop_Status — scratched players detected from prop line disappearance
  try {
    const statusRows = await getValues(SPREADSHEET_ID, SHEETS.PROP_STATUS);
    if (statusRows && statusRows.length > 1) {
      let resolved = 0, unresolved = 0;

      for (const row of statusRows.slice(1)) {
        const status = (row[4] || '').trim();
        if (status !== 'SCRATCHED') continue;

        const league = (row[1] || '').trim().toUpperCase();
        const player = (row[2] || '').trim();
        if (!league || !player) continue;

        // Look up player to get team and tier
        const info = findPlayer(playerLookup, league, player);

        if (info) {
          resolved++;
          const tierWeight = TIER_SEVERITY[info.tier] || TIER_SEVERITY.C;
          const tKey = `${league}|${info.team}`;
          if (!_teamInjuries[tKey]) _teamInjuries[tKey] = 0;
          _teamInjuries[tKey] = Math.min(1.0, _teamInjuries[tKey] + tierWeight);
        } else {
          unresolved++;
          // Fallback: can't determine team, use the old key_player flag
          const isKey = (row[5] || '').trim() === 'key_player';
          const weight = isKey ? 0.35 : 0.10;
          // Store by league|UNKNOWN_playerName — won't match any team query
          // but at least we log it
          console.log(`[injury-impact] Could not resolve team for ${player} (${league})`);
        }
      }

      if (resolved + unresolved > 0) {
        console.log(`[injury-impact] Prop_Status: ${resolved} resolved, ${unresolved} unresolved scratches`);
      }
    }
  } catch (e) {
    console.warn('[injury-impact] Could not read Prop_Status:', e.message);
  }

  // Source 2: Injury Summary sheet — contains team-level injury reports
  // Expected columns: Timestamp, League, Team, Player, Status, Position, Impact
  try {
    const injRows = await getValues(SPREADSHEET_ID, SHEETS.INJURY_SUMMARY);
    if (injRows && injRows.length > 1) {
      const headers = injRows[0].map(h => String(h).trim().toLowerCase());
      const leagueIdx = headers.findIndex(h => h === 'league' || h === 'sport');
      const teamIdx = headers.findIndex(h => h === 'team' || h === 'team_abbr' || h === 'abbr');
      const statusIdx = headers.findIndex(h => h === 'status' || h === 'injury_status');
      const impactIdx = headers.findIndex(h => h === 'impact' || h === 'severity');
      const playerIdx = headers.findIndex(h => h === 'player' || h === 'name');

      if (leagueIdx >= 0 && teamIdx >= 0) {
        for (let i = 1; i < injRows.length; i++) {
          const row = injRows[i];
          const league = (row[leagueIdx] || '').trim().toUpperCase();
          const team = (row[teamIdx] || '').trim().toUpperCase();
          if (!league || !team) continue;

          const status = (row[statusIdx] || '').trim().toLowerCase();
          if (status === 'active' || status === 'healthy' || status === 'available') continue;

          const playerName = playerIdx >= 0 ? (row[playerIdx] || '').trim() : '';
          const tKey = `${league}|${team}`;

          // Determine severity: player-tier-weighted if we can find the player
          let severity = 0;
          const statusMult = STATUS_MULTIPLIER[status] || 0.50;

          if (playerName) {
            const info = findPlayer(playerLookup, league, playerName);
            if (info) {
              // Tier-weighted severity × status multiplier
              severity = (TIER_SEVERITY[info.tier] || TIER_SEVERITY.C) * statusMult;
            } else {
              // Player not in stats sheets — use impact column or default
              severity = getImpactFallback(row, impactIdx, statusMult);
            }
          } else {
            // No player name — use impact column or status-based default
            severity = getImpactFallback(row, impactIdx, statusMult);
          }

          if (severity > 0) {
            if (!_teamInjuries[tKey]) _teamInjuries[tKey] = 0;
            _teamInjuries[tKey] = Math.min(1.0, _teamInjuries[tKey] + severity);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[injury-impact] Could not read Injury Summary:', e.message);
  }

  const teamCount = Object.keys(_teamInjuries).filter(k => _teamInjuries[k] > 0).length;
  if (teamCount > 0) {
    console.log(`[injury-impact] Final injury scores for ${teamCount} teams`);
  }

  return _teamInjuries;
}

/**
 * Fallback severity when player can't be resolved to a tier.
 * Uses the impact column if available, otherwise status-based defaults.
 */
function getImpactFallback(row, impactIdx, statusMult) {
  if (impactIdx >= 0) {
    const impact = (row[impactIdx] || '').trim().toLowerCase();
    if (impact === 'high' || impact === 'critical') return 0.35 * statusMult;
    if (impact === 'medium' || impact === 'moderate') return 0.20 * statusMult;
    if (impact === 'low' || impact === 'minor') return 0.08 * statusMult;
    const parsed = parseFloat(impact);
    if (!isNaN(parsed)) return parsed * statusMult;
  }
  // Default: moderate importance × status
  return 0.15 * statusMult;
}

/**
 * Get the injury severity score for a specific team.
 * @param {string} league - e.g., 'NBA'
 * @param {string} teamAbbr - e.g., 'BOS'
 * @returns {number} severity 0-1 (0 = healthy)
 */
function getTeamInjuryScore(league, teamAbbr) {
  if (!_teamInjuries) return 0;
  const key = `${league}|${teamAbbr}`;
  return _teamInjuries[key] || 0;
}

/**
 * Reset cache between trigger runs.
 */
function resetInjuryCache() {
  _teamInjuries = null;
}

module.exports = {
  loadInjuryImpact,
  getTeamInjuryScore,
  resetInjuryCache,
};
