'use strict';
/**
 * src/pitcher-data.js — MLB Probable Pitcher Fetcher
 * 
 * Pulls probable starting pitchers from ESPN MLB scoreboard.
 * Returns a map of game key → { homePitcher, awayPitcher } with stats.
 * 
 * Stats available from ESPN probables:
 *   - ERA (Earned Run Average)
 *   - W-L record
 *   - K (strikeouts)
 *   - SV (saves)
 * 
 * Used by predictions.js to feed pitcher quality into the game model.
 */

// 2026-05-31 fix bumped the totals-side AVG_ERA baseline (game-model.js) from
// 4.20 -> 4.40 because most starter ERAs were registering above the stale 4.20
// figure, creating a systematic bias. This is the same constant duplicated for
// the moneyline/spread pitcher-margin adjustment — it never got the same fix.
// Kept in sync with game-model.js's local AVG_ERA (2026-07-06).
const MLB_AVG_ERA = 4.40; // League average ERA (approximate)

/**
 * Fetch probable pitchers for today's MLB games from ESPN scoreboard.
 * @returns {Map<string, { homePitcher, awayPitcher, pitcherAdj }>}
 *   Key: "AwayTeam@HomeTeam" matching buildGameObjects format
 *   pitcherAdj: signed adjustment in runs (negative = home pitcher advantage)
 */
async function fetchProbablePitchers() {
  const map = new Map();

  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[pitcher-data] ESPN scoreboard returned ${res.status}`);
      return map;
    }
    const data = await res.json();
    const events = data.events || [];

    for (const event of events) {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
      const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
      if (!homeComp || !awayComp) continue;

      const homeTeam = homeComp.team?.displayName || '';
      const awayTeam = awayComp.team?.displayName || '';
      const commence = event.date || '';

      // Extract probable pitchers
      const homePitcher = extractPitcher(homeComp.probables);
      const awayPitcher = extractPitcher(awayComp.probables);

      // Compute pitcher quality differential
      const pitcherAdj = computePitcherAdj(homePitcher, awayPitcher);

      // Build key matching buildGameObjects format: "AwayFull@HomeFull"
      const gameKey = `${awayTeam}@${homeTeam}`;

      map.set(gameKey, {
        homePitcher,
        awayPitcher,
        pitcherAdj,
        commence,
      });

      if (homePitcher || awayPitcher) {
        console.log(`[pitcher-data] ${gameKey}: ${awayPitcher?.name || 'TBD'} (${awayPitcher?.era || '?'}) vs ${homePitcher?.name || 'TBD'} (${homePitcher?.era || '?'}) → adj: ${pitcherAdj.toFixed(2)}`);
      }
    }

    console.log(`[pitcher-data] Fetched probable pitchers for ${map.size} MLB games`);
  } catch (err) {
    console.error('[pitcher-data] Failed to fetch probable pitchers:', err.message);
  }

  return map;
}

/**
 * Extract pitcher info from ESPN probables array.
 */
function extractPitcher(probables) {
  if (!probables || probables.length === 0) return null;

  const prob = probables[0]; // First probable = starting pitcher
  const athlete = prob.athlete || {};
  const stats = prob.statistics || [];

  // Parse stats into a clean object
  const statMap = {};
  for (const s of stats) {
    statMap[s.name || s.abbreviation] = {
      value: s.value,
      display: s.displayValue,
      rank: s.rank || null,
    };
  }

  const era = statMap['ERA']?.value || null;
  const wl = statMap['wins-losses']?.display || statMap['wins']?.display || '';
  const ks = statMap['strikeouts']?.value || statMap['K']?.value || null;
  const wins = statMap['wins']?.value || (wl ? parseInt(wl.split('-')[0]) : null);
  const losses = statMap['losses']?.value || (wl ? parseInt(wl.split('-')[1]) : null);

  return {
    name: athlete.displayName || athlete.fullName || prob.displayName || '',
    id: athlete.id || prob.playerId || '',
    era,
    wins,
    losses,
    strikeouts: ks,
    rank: statMap['ERA']?.rank || null,
  };
}

/**
 * Compute a runs adjustment based on pitcher quality differential.
 * 
 * Logic: Compare each pitcher's ERA to league average.
 * A pitcher with 3.00 ERA vs league avg 4.20 = 1.20 runs better per 9 innings.
 * Scale to ~6 innings typical start = factor of 6/9 = 0.667.
 * 
 * The adjustment is from the HOME team's perspective:
 *   - Negative = home has the better pitcher (home advantage)
 *   - Positive = away has the better pitcher (away advantage)
 * 
 * This feeds into the margin projection as a direct runs adjustment.
 * 
 * @returns {number} Runs adjustment (typically -2.0 to +2.0)
 */
function computePitcherAdj(homePitcher, awayPitcher) {
  const homeERA = homePitcher?.era ?? MLB_AVG_ERA;
  const awayERA = awayPitcher?.era ?? MLB_AVG_ERA;

  // How many runs above/below average each pitcher allows per start (~6 IP)
  const INNINGS_FACTOR = 6 / 9; // typical starter goes ~6 innings
  const homeRunsVsAvg = (homeERA - MLB_AVG_ERA) * INNINGS_FACTOR;
  const awayRunsVsAvg = (awayERA - MLB_AVG_ERA) * INNINGS_FACTOR;

  // Net adjustment: home team benefits from away pitcher being bad,
  // and suffers from home pitcher being bad
  // homeRunsVsAvg > 0 means home pitcher gives up more runs (bad for home)
  // awayRunsVsAvg > 0 means away pitcher gives up more runs (good for home)
  const adj = awayRunsVsAvg - homeRunsVsAvg;

  // Cap at ±2.0 runs — even elite vs replacement is bounded
  return Math.max(-2.0, Math.min(2.0, adj));
}

module.exports = { fetchProbablePitchers, computePitcherAdj, extractPitcher };
