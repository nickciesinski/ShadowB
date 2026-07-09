'use strict';
/**
 * src/goalie-data.js — NHL Starting Goalie Fetcher
 *
 * NHL analog of src/pitcher-data.js (MLB probable pitchers).
 *
 * Key difference vs MLB: NHL starting goalies are usually NOT officially
 * published pre-game the way MLB probables are — starters are often only
 * confirmed at warmups. So this module uses a two-tier approach:
 *
 *   Tier 1 (confirmed/projected): ESPN NHL scoreboard `probables`, parsed
 *     defensively. ESPN only sometimes populates this for hockey, and the
 *     exact field names could not be live-verified when this was written
 *     (2026-07-09, NHL offseason — no games on the scoreboard). One-time
 *     diagnostic logging of the real response shape fires the first time
 *     real data appears, same pattern as the 2026-07-07 NBA stats fix.
 *
 *   Tier 2 (presumed): each team's #1 goalie inferred from the
 *     'NHL Goalie Stats' rankings sheet (written weekly by trigger18 /
 *     player-rankings.js): most games played, tie-broken by composite
 *     score. Presumed starters get their quality signal dampened (×0.7)
 *     because the backup starts ~1 in 3 games.
 *
 * Quality stat: save percentage (SV%) primary, GAA fallback.
 * Output adjustment is in GOALS, home-team perspective:
 *   positive = home goalie advantage (same sign convention game-model.js
 *   uses for MLB's pitcherAdj — note pitcher-data.js's own docstring had
 *   this backwards; see computePitcherAdj math).
 *
 * The adjustment is scaled in game-model.js by the tunable factor
 * `goalie_adj_scale` (config/model-params.NHL.json param_auto_goalie_adj_scale,
 * seeded conservatively at 0.5 per the convention for newly-wired,
 * not-yet-live-validated signals — see commits 554fea1 / e6ee86c).
 */

const { getValues } = require('./sheets');

const RANKINGS_SPREADSHEET_ID = process.env.RANKINGS_SPREADSHEET_ID || '';
const GOALIE_RANKINGS_SHEET = 'NHL Goalie Stats'; // written by player-rankings.js writeDetailSheet

// League environment constants. Kept as named constants at the top so they can
// be re-synced in ONE place — the MLB_AVG_ERA drift bug (stale 4.20 duplicated
// in two files until 2026-07-06) is the cautionary tale here.
const NHL_AVG_SVPCT = 0.900;      // league-average save % (approx, 2024-26 era)
const NHL_AVG_GAA = 2.90;         // league-average goals against avg (fallback stat)
const NHL_SHOTS_PER_GAME = 28.5;  // avg shots faced per team per game
const MARGIN_ADJ_CAP = 0.75;      // goals — elite starter vs weak backup is bounded
const TOTAL_ADJ_CAP = 0.50;       // goals — totals impact cap
const PRESUMED_DAMPEN = 0.70;     // presumed (not confirmed) starter: backup starts ~1/3 of games
const GAA_FALLBACK_SCALE = 0.5;   // GAA is team-defense polluted; trust it half as much as SV%

let _loggedProbablesShape = false; // one-time diagnostic flag

/**
 * Normalize a save percentage value into 0–1 form, or null if unusable.
 * Handles: 0.912, ".912", "91.2", 91.2 (percent form).
 */
function normalizeSvPct(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(String(raw).replace('%', ''));
  if (isNaN(n) || n <= 0) return null;
  if (n > 0 && n <= 1) return n;          // 0.912
  if (n > 1 && n <= 100) return n / 100;  // 91.2 percent form
  return null;
}

/** Normalize a GAA value, or null if unusable. Sane range gate: 0.5–8. */
function normalizeGaa(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0.5 || n > 8) return null;
  return n;
}

/** Lowercase alphanumeric team-name key so "St. Louis Blues" == "St Louis Blues". */
function normTeam(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A goalie's per-game goals-saved-vs-average, from the HOME/AWAY side's own
 * perspective (positive = this goalie is better than league average).
 * SV% primary; GAA fallback at half trust. Presumed starters dampened.
 */
function goalieGoalsVsAvg(goalie) {
  if (!goalie) return 0;
  const dampen = goalie.confirmed ? 1 : PRESUMED_DAMPEN;

  const sv = normalizeSvPct(goalie.savePct);
  if (sv !== null) {
    // 10 pts of SV% over ~28.5 shots ≈ 0.29 goals/game saved
    return NHL_SHOTS_PER_GAME * (sv - NHL_AVG_SVPCT) * dampen;
  }
  const gaa = normalizeGaa(goalie.gaa);
  if (gaa !== null) {
    // GAA is already goals/game; lower is better
    return (NHL_AVG_GAA - gaa) * GAA_FALLBACK_SCALE * dampen;
  }
  return 0; // no usable stat → contribute nothing (never guess)
}

/**
 * Signed moneyline/spread adjustment in goals, home perspective.
 * Positive = home goalie advantage. Capped at ±0.75.
 * Missing/unknown goalies contribute 0 → adjustment degrades to 0 gracefully.
 */
function computeGoalieAdj(homeGoalie, awayGoalie) {
  const adj = goalieGoalsVsAvg(homeGoalie) - goalieGoalsVsAvg(awayGoalie);
  return Math.max(-MARGIN_ADJ_CAP, Math.min(MARGIN_ADJ_CAP, adj));
}

/**
 * Totals adjustment in goals. Two above-average goalies → fewer total goals
 * (negative adj); two weak goalies → more (positive). Mirrors MLB's
 * pitcherTotalAdj shape. Capped at ±0.5.
 */
function computeGoalieTotalAdj(homeGoalie, awayGoalie) {
  const avgQuality = (goalieGoalsVsAvg(homeGoalie) + goalieGoalsVsAvg(awayGoalie)) / 2;
  const adj = -avgQuality; // better goalies = lower total
  return Math.max(-TOTAL_ADJ_CAP, Math.min(TOTAL_ADJ_CAP, adj)) + 0; // +0 normalizes -0
}

/**
 * Defensively extract a goalie from an ESPN competitor `probables` array,
 * if ESPN ever populates one for NHL. Field names UNVERIFIED against live
 * NHL data (offseason at write time) — parser accepts the MLB probables
 * shape plus reasonable variants, and logs the raw shape once so the real
 * schema can be confirmed from trigger logs when the season starts.
 */
function extractGoalieFromProbables(probables) {
  if (!probables || probables.length === 0) return null;

  if (!_loggedProbablesShape) {
    _loggedProbablesShape = true;
    try {
      console.log('[goalie-data] DIAGNOSTIC (one-time): raw NHL probables[0] =',
        JSON.stringify(probables[0]).slice(0, 800));
    } catch (_) { /* ignore */ }
  }

  const prob = probables[0];
  const athlete = prob.athlete || {};
  const stats = prob.statistics || prob.stats || [];

  const statMap = {};
  for (const s of stats) {
    const k = s.name || s.abbreviation || s.displayName || '';
    statMap[String(k)] = { value: s.value, display: s.displayValue };
  }

  // Candidate keys for SV% / GAA across ESPN naming variants
  const svRaw = statMap['savePct']?.value ?? statMap['savePercentage']?.value
    ?? statMap['SV%']?.value ?? statMap['savePct']?.display ?? null;
  const gaaRaw = statMap['goalsAgainstAverage']?.value ?? statMap['GAA']?.value
    ?? statMap['avgGoalsAgainst']?.value ?? null;

  const name = athlete.displayName || athlete.fullName || prob.displayName || '';
  if (!name) return null;

  return {
    name,
    id: athlete.id || prob.playerId || '',
    savePct: svRaw,
    gaa: gaaRaw,
    confirmed: true, // if ESPN lists a probable, treat as confirmed/projected starter
  };
}

/**
 * From a team's goalies (rankings-sheet rows), pick the presumed #1:
 * most games played, tie-broken by composite score.
 */
function pickPresumedStarter(goalies) {
  if (!goalies || goalies.length === 0) return null;
  const sorted = [...goalies].sort((a, b) =>
    (b.gp || 0) - (a.gp || 0) || (b.score || 0) - (a.score || 0));
  return { ...sorted[0], confirmed: false };
}

/**
 * Read the weekly 'NHL Goalie Stats' rankings sheet and build a
 * normTeam(team) → presumed starter map.
 * Sheet schema (player-rankings.js writeDetailSheet, NHL_GOALIE group):
 *   [Player Name, Team, Position, Score, W, L, SO, GP, Saves, SV%, GAA]
 *    col 0        1     2         3      4  5  6   7   8      9    10
 */
async function buildPresumedStarterMap() {
  const map = new Map(); // normTeam → goalie
  if (!RANKINGS_SPREADSHEET_ID) {
    console.warn('[goalie-data] RANKINGS_SPREADSHEET_ID not set — presumed-starter fallback unavailable');
    return map;
  }

  let rows;
  try {
    rows = await getValues(RANKINGS_SPREADSHEET_ID, GOALIE_RANKINGS_SHEET);
  } catch (err) {
    console.warn('[goalie-data] Could not read goalie rankings sheet:', err.message);
    return map;
  }
  if (!rows || rows.length < 2) return map;

  // Group goalies by team
  const byTeam = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[0] || '').trim();
    const team = (r[1] || '').trim();
    if (!name || !team) continue;
    const g = {
      name,
      team,
      score: parseFloat(r[3]) || 0,
      gp: parseFloat(r[7]) || 0,
      savePct: r[9],
      gaa: r[10],
    };
    const key = normTeam(team);
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(g);
  }

  for (const [key, goalies] of byTeam.entries()) {
    const starter = pickPresumedStarter(goalies);
    if (starter) map.set(key, starter);
  }

  console.log(`[goalie-data] Presumed starters built for ${map.size} teams from rankings sheet`);
  return map;
}

/**
 * Try ESPN NHL scoreboard for probable/confirmed starting goalies.
 * Returns normTeam(team) → goalie map (confirmed=true). Empty map on any
 * failure — the presumed-starter fallback covers the gap.
 */
async function fetchEspnProbableGoalies() {
  const map = new Map();
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[goalie-data] ESPN scoreboard returned ${res.status}`);
      return map;
    }
    const data = await res.json();
    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      for (const c of (comp.competitors || [])) {
        const teamName = c.team?.displayName || '';
        const goalie = extractGoalieFromProbables(c.probables);
        if (teamName && goalie) map.set(normTeam(teamName), goalie);
      }
    }
    if (map.size > 0) {
      console.log(`[goalie-data] ESPN listed probable goalies for ${map.size} teams`);
    }
  } catch (err) {
    console.warn('[goalie-data] ESPN probable-goalie fetch failed (non-fatal):', err.message);
  }
  return map;
}

/**
 * Main entry: build a per-game starting-goalie map for today's NHL slate.
 *
 * Unlike MLB's fetchProbablePitchers (which keys by ESPN team names and can
 * silently miss when Odds API names differ), this takes the games list and
 * keys the map by each game's own `${game.away}@${game.home}` — so the
 * lookup in game-model.js always hits when we have data for that game.
 *
 * @param {Array} games - buildGameObjects output: [{ home, away, ... }]
 * @returns {Map<string, { homeGoalie, awayGoalie, goalieAdj, goalieTotalAdj }>}
 */
async function fetchStartingGoalies(games) {
  const map = new Map();
  if (!games || games.length === 0) return map;

  // Tier 1: ESPN confirmed/projected. Tier 2: rankings-sheet presumed.
  const [espnMap, presumedMap] = await Promise.all([
    fetchEspnProbableGoalies(),
    buildPresumedStarterMap(),
  ]);

  for (const game of games) {
    const homeKey = normTeam(game.home);
    const awayKey = normTeam(game.away);

    const homeGoalie = espnMap.get(homeKey) || presumedMap.get(homeKey) || null;
    const awayGoalie = espnMap.get(awayKey) || presumedMap.get(awayKey) || null;
    if (!homeGoalie && !awayGoalie) continue; // nothing to say about this game

    const goalieAdj = computeGoalieAdj(homeGoalie, awayGoalie);
    const goalieTotalAdj = computeGoalieTotalAdj(homeGoalie, awayGoalie);

    map.set(`${game.away}@${game.home}`, {
      homeGoalie, awayGoalie, goalieAdj, goalieTotalAdj,
    });

    console.log(`[goalie-data] ${game.away}@${game.home}: ` +
      `${awayGoalie?.name || 'TBD'}${awayGoalie && !awayGoalie.confirmed ? ' (presumed)' : ''} vs ` +
      `${homeGoalie?.name || 'TBD'}${homeGoalie && !homeGoalie.confirmed ? ' (presumed)' : ''} ` +
      `→ adj: ${goalieAdj.toFixed(2)}, totalAdj: ${goalieTotalAdj.toFixed(2)}`);
  }

  console.log(`[goalie-data] Built goalie data for ${map.size}/${games.length} NHL games`);
  return map;
}

module.exports = {
  fetchStartingGoalies,
  computeGoalieAdj,
  computeGoalieTotalAdj,
  extractGoalieFromProbables,
  pickPresumedStarter,
  goalieGoalsVsAvg,
  normalizeSvPct,
  normalizeGaa,
  normTeam,
  buildPresumedStarterMap,
  // exported for tests / single-source sync
  NHL_AVG_SVPCT, NHL_AVG_GAA, NHL_SHOTS_PER_GAME,
  MARGIN_ADJ_CAP, TOTAL_ADJ_CAP, PRESUMED_DAMPEN,
};
