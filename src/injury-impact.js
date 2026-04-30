'use strict';
/**
 * src/injury-impact.js — Team-level injury impact for game predictions
 *
 * Reads Prop_Status (scratched key players) and Injury Summary sheet
 * to compute a per-team injury severity score (0-1) for use by the
 * game model's feature extraction.
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

/**
 * Load injury data from Prop_Status + Injury Summary and compute
 * per-team severity scores.
 *
 * @returns {Object} Map of "league|teamAbbr" → severity (0-1)
 */
async function loadInjuryImpact() {
  if (_teamInjuries) return _teamInjuries;
  _teamInjuries = {};

  // Source 1: Prop_Status — scratched players detected from prop line disappearance
  try {
    const statusRows = await getValues(SPREADSHEET_ID, SHEETS.PROP_STATUS);
    if (statusRows && statusRows.length > 1) {
      for (const row of statusRows.slice(1)) {
        const status = (row[4] || '').trim();
        if (status !== 'SCRATCHED') continue;
        const league = (row[1] || '').trim();
        const player = (row[2] || '').trim();
        const isKey = (row[5] || '').trim() === 'key_player';
        const game = (row[3] || '').trim();

        // Try to determine team from game string (e.g., "Team A vs Team B")
        // We'll aggregate by game teams later
        if (!league) continue;

        // Weight: key players = 0.35, role players = 0.10
        const weight = isKey ? 0.35 : 0.10;

        // Extract both teams from game string and apply to the scratched player's team
        // Since we don't know which team the player is on from Prop_Status alone,
        // store by player name and resolve later
        const pKey = `${league}|${player}`;
        if (!_teamInjuries[pKey]) _teamInjuries[pKey] = 0;
        _teamInjuries[pKey] = Math.min(1.0, _teamInjuries[pKey] + weight);
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
        // Only look at recent entries (last row per team takes precedence)
        const teamScores = {}; // "league|team" → cumulative severity

        for (let i = 1; i < injRows.length; i++) {
          const row = injRows[i];
          const league = (row[leagueIdx] || '').trim().toUpperCase();
          const team = (row[teamIdx] || '').trim().toUpperCase();
          if (!league || !team) continue;

          const status = (row[statusIdx] || '').trim().toLowerCase();
          // Skip healthy/active players
          if (status === 'active' || status === 'healthy' || status === 'available') continue;

          const tKey = `${league}|${team}`;

          // Determine severity from impact column or status
          let severity = 0;
          if (impactIdx >= 0) {
            const impact = (row[impactIdx] || '').trim().toLowerCase();
            if (impact === 'high' || impact === 'critical') severity = 0.35;
            else if (impact === 'medium' || impact === 'moderate') severity = 0.20;
            else if (impact === 'low' || impact === 'minor') severity = 0.08;
            else severity = parseFloat(impact) || 0.10;
          } else {
            // Infer from status
            if (status === 'out' || status === 'o') severity = 0.25;
            else if (status === 'doubtful' || status === 'd') severity = 0.20;
            else if (status === 'questionable' || status === 'q') severity = 0.10;
            else if (status === 'probable' || status === 'p') severity = 0.03;
            else if (status === 'day-to-day' || status === 'dtd') severity = 0.08;
            else severity = 0.10;
          }

          if (!teamScores[tKey]) teamScores[tKey] = 0;
          teamScores[tKey] = Math.min(1.0, teamScores[tKey] + severity);
        }

        // Merge into _teamInjuries
        for (const [key, score] of Object.entries(teamScores)) {
          if (!_teamInjuries[key]) _teamInjuries[key] = 0;
          _teamInjuries[key] = Math.min(1.0, Math.max(_teamInjuries[key], score));
        }
      }
    }
  } catch (e) {
    console.warn('[injury-impact] Could not read Injury Summary:', e.message);
  }

  const teamCount = Object.keys(_teamInjuries).filter(k => _teamInjuries[k] > 0).length;
  if (teamCount > 0) {
    console.log(`[injury-impact] Loaded injury data for ${teamCount} teams/players`);
  }

  return _teamInjuries;
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
