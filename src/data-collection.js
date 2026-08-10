'use strict';
// =============================================================
// src/data-collection.js â ESPN + Odds API fetching & grading
// Replaces: Data Collection (Apps Script)
//
// Sprint 2 (April 2026): Expanded team stats â off/def ratings,
// pace, scoring averages, recent form, rest/schedule data.
// =============================================================

const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, ODDS_API_BASE, SPORTS, MARKETS } = require('./config');
const db = require('./db');
const { dataModeFor } = require('./config');
const { getValues, setValues, appendRows, clearSheet, ensureSheet } = require('./sheets');
const { logApiCall } = require('./monitoring');
const { persistGameOdds } = require('./odds-sink');
const { persistSnapshotFirst } = require('./snapshot-sink');
const LOCK_POLICY = require('../config/lock-policy.json');
const { probe, probeKeys } = require('./debug-probe'); // 2026-08-10 diagnostics to DB, not logs

// Odds API cost estimate: $0 for free tier up to 500 req/mo, then prorated.
// We log a flat $0.001/call placeholder so the API_Usage_Log has a signal to sum.
const ODDS_API_COST_PER_CALL = 0.001;

// ESPN sport key mapping (for ESPN API URLs)
const ESPN_SPORTS = {
  MLB: { sport: 'baseball', league: 'mlb' },
  NBA: { sport: 'basketball', league: 'nba' },
  NFL: { sport: 'football', league: 'nfl' },
  NHL: { sport: 'hockey', league: 'nhl' },
};

// ââ ESPN API ââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Fetch player stats from ESPN API and write to PlayerStats sheet.
 * Trigger 1: 3:30 AM ET daily (trigger1)
 */
async function updatePlayerStats() {
  console.log('[data-collection] Updating player stats from ESPN (rosters + leaders)...');
  const sports = [
    { key: 'baseball', league: 'mlb', label: 'MLB', sheet: 'MLB_PLAYERS' },
    { key: 'basketball', league: 'nba', label: 'NBA', sheet: 'NBA_PLAYERS' },
    { key: 'hockey', league: 'nhl', label: 'NHL', sheet: 'NHL_PLAYERS' },
    { key: 'football', league: 'nfl', label: 'NFL', sheet: 'NFL_PLAYERS' },
  ];

  // Stat columns appended after the base 6 roster columns
  const STAT_COLS = {
    MLB: ['AVG', 'HR', 'RBI', 'OPS', 'SB', 'ERA', 'W', 'SO', 'WHIP', 'SV'],
    NBA: ['PTS', 'REB', 'AST', 'STL', 'BLK', 'FG%', '3P%', 'MPG'],
    NHL: ['G', 'A', 'PTS', '+/-', 'SOG', 'PPG', 'SV%', 'GAA', 'W-G'],
    NFL: ['PASS_YD', 'PASS_TD', 'QBR', 'RUSH_YD', 'RUSH_TD', 'REC_YD', 'REC_TD', 'REC', 'SACK', 'INT'],
  };

  const HEADER_BASE = ['Name', 'Team', 'League', 'Position', 'ESPN_ID', 'Jersey'];
  const allRows = [];

  for (const { key, league, label, sheet } of sports) {
    const statCols = STAT_COLS[label] || [];
    const HEADER = [...HEADER_BASE, ...statCols];
    if (allRows.length === 0) allRows.push([...HEADER_BASE, 'Stat1', 'Stat2', 'Stat3', 'Stat4', 'Stat5']);
    const leagueRows = [HEADER];
    const playerStats = {}; // ESPN_ID → { stat: value }

    try {
      // ── Step 1: Fetch leaders to get actual performance stats ──
      const leadersUrl = `https://site.api.espn.com/apis/site/v2/sports/${key}/${league}/leaders?limit=100`;
      let leadersData = null;
      try {
        const lRes = await fetch(leadersUrl, { signal: AbortSignal.timeout(15000) });
        if (lRes.ok) leadersData = await lRes.json();
      } catch (e) {
        console.warn(`[data-collection] ESPN ${label} leaders fetch failed: ${e.message}`);
      }

      if (leadersData?.leaders) {
        for (const cat of leadersData.leaders) {
          const catName = (cat.abbreviation || cat.name || '').toLowerCase();
          for (const leader of (cat.leaders || [])) {
            const ath = leader.athlete;
            if (!ath?.id) continue;
            const id = String(ath.id);
            if (!playerStats[id]) playerStats[id] = {};
            playerStats[id][catName] = leader.value;
            playerStats[id]._rank = playerStats[id]._rank || {};
            playerStats[id]._rank[catName] = leader.rank || 999;
            // Stash team from leaders in case roster is missing it
            if (ath.team?.abbreviation) playerStats[id]._teamAbbr = ath.team.abbreviation;
            if (ath.displayName) playerStats[id]._name = ath.displayName;
          }
        }
        console.log(`[data-collection] ${label}: Leaders data for ${Object.keys(playerStats).length} players`);
      }

      // ── Step 2: Fetch full rosters (name→team mapping + position) ──
      const teamsUrl = `https://site.api.espn.com/apis/site/v2/sports/${key}/${league}/teams`;
      const teamsRes = await fetch(teamsUrl, { signal: AbortSignal.timeout(15000) });
      if (!teamsRes.ok) { console.warn(`ESPN ${label} teams returned ${teamsRes.status}`); continue; }
      const teamsData = await teamsRes.json();
      const teams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];

      for (const { team } of teams) {
        const abbr = team.abbreviation || '';
        try {
          const rosterUrl = `https://site.api.espn.com/apis/site/v2/sports/${key}/${league}/teams/${abbr}/roster`;
          const rosterRes = await fetch(rosterUrl, { signal: AbortSignal.timeout(10000) });
          if (!rosterRes.ok) continue;
          const rosterData = await rosterRes.json();
          const groups = rosterData.athletes || [];

          for (const group of groups) {
            const players = group.items || [];
            for (const p of players) {
              const espnId = String(p.id || '');
              const name = p.displayName || p.fullName || '';
              const pos = p.position?.abbreviation || '';

              // Build base row: [Name, Team, League, Position, ESPN_ID, Jersey]
              const row = [name, abbr, label, pos, espnId, p.jersey || ''];

              // Append stat values from leaders data (if this player appeared)
              const stats = playerStats[espnId] || {};
              const statValues = mapLeaderStatsToColumns(label, stats);
              row.push(...statValues);

              leagueRows.push(row);
              allRows.push([name, abbr, label, pos, espnId, p.jersey || '', ...statValues.slice(0, 5)]);
            }
          }
        } catch (e) {
          // Skip individual team roster failures silently
        }
      }

      // ── Step 3: Add leaders-only players not found on rosters ──
      // (traded players, edge cases where roster didn't include them)
      const rosterIds = new Set(leagueRows.slice(1).map(r => String(r[4])));
      for (const [id, stats] of Object.entries(playerStats)) {
        if (rosterIds.has(id)) continue;
        if (!stats._name || !stats._teamAbbr) continue;
        const row = [stats._name, stats._teamAbbr, label, '', id, ''];
        const statValues = mapLeaderStatsToColumns(label, stats);
        row.push(...statValues);
        leagueRows.push(row);
      }

      // Write per-league sheet
      const sheetName = SHEETS[sheet];
      if (sheetName && leagueRows.length > 1) {
        await clearSheet(SPREADSHEET_ID, sheetName);
        await setValues(SPREADSHEET_ID, sheetName, 'A1', leagueRows);
        const withStats = leagueRows.slice(1).filter(r => r.length > 6 && r.slice(6).some(v => v !== '')).length;
        console.log(`[data-collection] ${label}: ${leagueRows.length - 1} players (${withStats} with stats)`);
      }
    } catch (err) {
      console.error(`[data-collection] ESPN ${label} error:`, err.message);
    }
  }

  // Write combined PLAYER_STATS sheet (auto-create if missing)
  if (allRows.length > 0) {
    await ensureSheet(SPREADSHEET_ID, SHEETS.PLAYER_STATS);
    await clearSheet(SPREADSHEET_ID, SHEETS.PLAYER_STATS);
    await setValues(SPREADSHEET_ID, SHEETS.PLAYER_STATS, 'A1', allRows);
  }
  console.log(`[data-collection] Player stats updated: ${allRows.length - 1} players across 4 leagues`);
}

/**
 * Map ESPN leaders stat names to our fixed column order per league.
 * Returns an array of values matching STAT_COLS[league] order.
 */
function mapLeaderStatsToColumns(league, stats) {
  // ESPN leaders use various stat name formats — normalize here
  const STAT_MAPPING = {
    MLB: [
      s => s.avg || s.battingaverage || s.battingAverage || '',
      s => s.homeRuns || s.homeruns || s.hr || '',
      s => s.RBIs || s.rbis || s.rbi || '',
      s => s.ops || s.OPS || '',
      s => s.stolenBases || s.stolenbases || s.sb || '',
      s => s.ERA || s.era || s.earnedRunAverage || '',
      s => s.wins || s.w || '',
      s => s.strikeouts || s.so || '',
      s => s.WHIP || s.whip || '',
      s => s.saves || s.sv || '',
    ],
    NBA: [
      s => s.points || s.pts || s.pointsPerGame || '',
      s => s.rebounds || s.reb || s.reboundsPerGame || '',
      s => s.assists || s.ast || s.assistsPerGame || '',
      s => s.steals || s.stl || s.stealsPerGame || '',
      s => s.blocks || s.blk || s.blocksPerGame || '',
      s => s.fieldGoalPct || s.fgPct || s['fg%'] || '',
      s => s.threePointPct || s['3ptPct'] || s['3p%'] || '',
      s => s.minutesPerGame || s.mpg || s.minutes || '',
    ],
    NHL: [
      s => s.goals || s.g || '',
      s => s.assists || s.a || '',
      s => s.points || s.pts || '',
      s => s.plusMinus || s['plus-minus'] || s['+/-'] || '',
      s => s.shots || s.shotsOnGoal || s.sog || '',
      s => s.powerPlayGoals || s.ppg || '',
      s => s.savePct || s.savePercentage || s['sv%'] || '',
      s => s.goalsAgainstAverage || s.gaa || '',
      s => s['wins-goalie'] || s.winsGoalie || '',
    ],
    NFL: [
      s => s.passingYards || s.passYards || '',
      s => s.passingTouchdowns || s.passTD || '',
      s => s.QBRating || s.qbr || s.passerRating || '',
      s => s.rushingYards || s.rushYards || '',
      s => s.rushingTouchdowns || s.rushTD || '',
      s => s.receivingYards || s.recYards || '',
      s => s.receivingTouchdowns || s.recTD || '',
      s => s.receptions || s.rec || '',
      s => s.sacks || '',
      s => s.interceptions || s.int || '',
    ],
  };

  const mappers = STAT_MAPPING[league] || [];
  return mappers.map(fn => {
    const val = fn(stats);
    return val !== '' && val !== undefined && val !== null ? val : '';
  });
}


/**
 * Fetch team stats from ESPN API and write to TeamStats sheet.
 * Sprint 2: now pulls offensive/defensive ratings, scoring averages,
 * pace (NBA), and recent form alongside W-L records.
 *
 * Trigger 2: 4:00 AM ET daily (trigger2)
 */
async function updateTeamStats() {
  console.log('[data-collection] Updating team stats from ESPN (enriched)...');

  const HEADER = [
    'Timestamp', 'Sport', 'Team', 'Abbreviation',
    'Win', 'Loss', 'WinPct',
    // Sprint 2 additions
    'OffRating', 'DefRating', 'Pace',
    'RunsPerGame', 'RunsAllowedPerGame',
    'GoalsFor', 'GoalsAgainst',
    'PointsFor', 'PointsAgainst',
    'RecentFormPct', 'Last10W', 'Last10L',
    // 2026-08-08 — real ordered form windows (indices 19-21). MUST stay in
    // step with the row push below; a header shorter than the data rows leaves
    // real columns sitting under no heading, which is invisible in the sheet
    // and exactly the silent-failure class this system keeps hitting.
    'FormL1', 'FormL3', 'FormL5',
    // 2026-08-08 — indices 22-32. MLB team batting/pitching + NFL yardage,
    // efficiency and turnovers, all of which carried weight but were never
    // collected. Sparse by design: MLB fills 22-24, NFL fills 25-32.
    'OPS', 'BattingAvg', 'WHIP', 'YardsPerGame', 'OppYardsPerGame', 'PassYardsPerGame', 'RushYardsPerGame', 'ThirdDownPct', 'RedZonePct', 'Takeaways', 'Giveaways',
  ];
  const allRows = [HEADER];
  const ts = new Date().toISOString();

  for (const [leagueName, espn] of Object.entries(ESPN_SPORTS)) {
    try {
      // ââ Step 1: Basic W-L from /teams endpoint ââ
      const teamsUrl = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams`;
      const teamsRes = await fetch(teamsUrl, { signal: AbortSignal.timeout(30000) });
      if (!teamsRes.ok) {
        console.warn(`ESPN teams ${leagueName} returned ${teamsRes.status}`);
        continue;
      }
      const teamsData = await teamsRes.json();
      const teams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];

      // Build a map of team abbreviation â basic record
      const teamMap = {};
      for (const { team } of teams) {
        const abbr = team.abbreviation || '';
        const record = team.record?.items?.[0]?.summary || '0-0';
        const [w, l] = record.split('-').map(Number);
        const pct = w + l > 0 ? (w / (w + l)).toFixed(3) : '0.000';
        teamMap[abbr] = {
          name: team.displayName || '',
          abbr,
          wins: w || 0,
          losses: l || 0,
          pct,
          offRating: '', defRating: '', pace: '',
          runsPerGame: '', runsAllowedPerGame: '',
          goalsFor: '', goalsAgainst: '',
          pointsFor: '', pointsAgainst: '',
          recentFormPct: '', last10W: '', last10L: '',
          formL1: '', formL3: '', formL5: '',
          ops: '', battingAvg: '', whip: '', yardsPerGame: '', oppYardsPerGame: '', passYardsPerGame: '', rushYardsPerGame: '', thirdDownPct: '', redZonePct: '', takeaways: '', giveaways: '',
        };
      }

      // ââ Step 2: Enriched stats from /standings or /scoreboard ââ
      await enrichTeamStats(leagueName, espn, teamMap);

      // ââ Step 3: Recent form (last 10 results) ââ
      await enrichRecentForm(leagueName, espn, teamMap);

      // Write rows
      for (const t of Object.values(teamMap)) {
        allRows.push([
          ts, leagueName, t.name, t.abbr,
          t.wins, t.losses, t.pct,
          t.offRating, t.defRating, t.pace,
          t.runsPerGame, t.runsAllowedPerGame,
          t.goalsFor, t.goalsAgainst,
          t.pointsFor, t.pointsAgainst,
          t.recentFormPct, t.last10W, t.last10L,
          // Appended 2026-08-08 at indices 19-21. Additive: every existing
          // reader indexes 0-18 and is unaffected.
          t.formL1, t.formL3, t.formL5,
          t.ops, t.battingAvg, t.whip, t.yardsPerGame, t.oppYardsPerGame, t.passYardsPerGame, t.rushYardsPerGame, t.thirdDownPct, t.redZonePct, t.takeaways, t.giveaways,
        ]);
      }

      console.log(`[data-collection] ${leagueName}: enriched stats for ${Object.keys(teamMap).length} teams`);
    } catch (err) {
      console.error(`[data-collection] ESPN teams ${leagueName} error:`, err.message);
    }
  }

  // Write to all league-specific sheets + the default TEAM_STATS sheet
  await clearSheet(SPREADSHEET_ID, SHEETS.TEAM_STATS);
  await setValues(SPREADSHEET_ID, SHEETS.TEAM_STATS, 'A1', allRows);

  // Also write league-specific sheets for per-sport lookups
  for (const leagueName of Object.keys(ESPN_SPORTS)) {
    const sheetKey = `${leagueName}_TEAM_STATS`;
    if (SHEETS[sheetKey]) {
      const leagueRows = [HEADER, ...allRows.slice(1).filter(r => r[1] === leagueName)];
      await clearSheet(SPREADSHEET_ID, SHEETS[sheetKey]);
      await setValues(SPREADSHEET_ID, SHEETS[sheetKey], 'A1', leagueRows);
    }
  }

  console.log(`[data-collection] Team stats updated: ${allRows.length - 1} rows (enriched)`);
}

// ââ Enrichment: Offensive / Defensive / Pace stats âââââââââââ

/**
 * Pull additional stats per team from ESPN endpoints.
 * Each league uses different stat sources because ESPN's API
 * structure varies by sport.
 */
async function enrichTeamStats(league, espn, teamMap) {
  try {
    switch (league) {
      case 'NBA':
        await enrichNBA(espn, teamMap);
        break;
      case 'MLB':
        await enrichMLB(espn, teamMap);
        break;
      case 'NHL':
        await enrichNHL(espn, teamMap);
        break;
      case 'NFL':
        await enrichNFL(espn, teamMap);
        break;
    }
  } catch (err) {
    console.warn(`[data-collection] Enrichment failed for ${league}:`, err.message);
    // Non-fatal: model falls back to W-L if enrichment fails
  }
}

/**
 * NBA: Pull team stats page for offensive/defensive rating and pace.
 * ESPN exposes these on the team's stats endpoint.
 *
 * 2026-07-07: `defensiveRating`/`avgPointsAgainst` and `pace`/`possessions`
 * were never matching anything real -- Supabase's daily_team_stats snapshot
 * (a direct passthrough of this same Sheet data) showed def_rating and pace
 * as null for every single NBA team, while off_rating (via the avgPoints
 * fallback) was fine. That silently kills pace_diff/pace_factor/pace_combined
 * (weight 1.0 on the total market -- the single largest NBA total coefficient)
 * and defensive_rating_diff, and also makes the core scoringDifferential
 * strength calc always fall back to win%+form only (it requires both off AND
 * def rating or returns null) -- for every NBA game.
 *
 * I don't have live network access to ESPN's API from this environment to
 * confirm the exact real field names, so this is a best-effort widening of
 * the candidate list based on ESPN's common team-stat naming patterns, plus:
 *   1. One-time diagnostic logging of every stat name ESPN actually returned
 *      -- check GitHub Actions logs for "[data-collection] NBA stat keys"
 *      after this deploys, and refine the field name from there if these
 *      guesses still miss.
 *   2. A derived defRating fallback from pointsAgainst (which does resolve),
 *      so the feature carries real signal instead of a guaranteed zero even
 *      if none of the named-field guesses land.
 * Pace has no simple derivation from basic per-game stats, so if the widened
 * candidates still miss, it stays 0 (paceAdjustment() already guards this
 * safely -- no crash, just no signal, same as today).
 */
let _nbaStatKeysLogged = false;
async function enrichNBA(espn, teamMap) {
  // The scoreboard gives us today's schedule; for ratings we hit each team
  for (const abbr of Object.keys(teamMap)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams/${abbr}/statistics`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();

      // ESPN returns stats in categories â stats array
      const stats = flattenESPNStats(data);

      if (!_nbaStatKeysLogged) {
        _nbaStatKeysLogged = true;
        console.log(`[data-collection] NBA stat keys (${abbr}, for verifying the field-name guesses below): ${Object.keys(stats).join(', ')}`);
      }

      const pointsFor = stats['avgPoints'] || stats['points'] || stats['pointsPerGame'] || '';
      const pointsAgainst = stats['avgPointsAgainst'] || stats['opponentPoints'] || stats['opponentPointsPerGame']
        || stats['avgOpponentPoints'] || stats['pointsAllowed'] || stats['avgPointsAllowed'] || '';

      teamMap[abbr].offRating = stats['offensiveRating'] || stats['offRtg'] || pointsFor || '';
      teamMap[abbr].defRating = stats['defensiveRating'] || stats['defRtg'] || pointsAgainst || '';
      teamMap[abbr].pace = stats['pace'] || stats['paceFactor'] || stats['possessions'] || stats['avgPossessions'] || '';
      teamMap[abbr].pointsFor = pointsFor;
      teamMap[abbr].pointsAgainst = pointsAgainst;
    } catch (err) {
      // Skip individual team failures silently
    }
  }
  console.log('[data-collection] NBA enrichment complete');
}

/**
 * MLB: Pull runs scored / runs allowed per game.
 */
// 2026-08-08 — resolve a per-game MLB rate. Prefers an explicit average, then
// derives total/gamesPlayed, and finally REJECTS anything outside a plausible
// range rather than passing it downstream. Silent bad data is the failure mode
// that has cost this system the most; a rejected stat degrades the feature to
// 0, which is honest, instead of injecting a five-figure number into a linear
// model where nothing clamps it.
const MLB_RATE_MIN = 0.5;   // no team scores under half a run a game
const MLB_RATE_MAX = 15;    // nor over fifteen

// 2026-08-08 — generalised from mlbPerGame. Resolves a stat, preferring an
// explicit per-game average, then deriving total/gamesPlayed, then REJECTING
// anything outside a plausible range instead of passing it downstream.
//
// The range check is the important part and it is not paranoia: ESPN returns
// season totals and per-game rates under confusingly similar names, and
// picking the wrong one is silent. That is exactly how mlb_run_diff ran at
// -5825 for months. scoreMarket() is an unbounded linear sum with no clamping,
// so one bad stat can dominate every other feature. Returning '' degrades the
// feature to 0, which is honest; returning a five-figure number is not.
//
// `range` is [min, max] for the PER-GAME value. Pass rate:false for stats that
// are already percentages/ratios and must not be divided by games played.
function perGameStat(stats, keys, opts = {}) {
  const [lo, hi] = opts.range || [0, Infinity];
  const label = opts.label || keys[0];
  for (const k of keys) {
    const v = parseFloat(stats[k]);
    if (Number.isFinite(v) && v >= lo && v <= hi) return v;
  }
  if (opts.totalKeys) {
    const gp = parseFloat(stats['gamesPlayed'] ?? stats['GP'] ?? stats['games']);
    if (Number.isFinite(gp) && gp > 0) {
      for (const k of opts.totalKeys) {
        const v = parseFloat(stats[k]);
        if (!Number.isFinite(v)) continue;
        const rate = v / gp;
        if (rate >= lo && rate <= hi) return rate;
      }
    }
  }
  if (opts.quiet !== true) {
    console.log(`[data-collection] no plausible value for ${label} — feature degraded to 0`);
  }
  return '';
}

// 2026-08-10 — DERIVE FIRST for MLB.
//
// Observed in production: runsAllowedPerGame resolved correctly (~4.3) while
// runsPerGame came through at season scale, despite an identical resolver and
// the same range guard. The difference is which path won. The derived path
// (category total / gamesPlayed) is provably correct -- it is what produces
// the right runsAllowedPerGame -- whereas some ESPN "average"-named key for
// runs is returning a season figure that then fails the range check and falls
// through to a worse fallback.
//
// So try the arithmetic we can verify BEFORE trusting a key name we cannot.
// gamesPlayed is a number we can sanity-check; a stat label is not. If the
// derivation is unavailable the avg keys still apply, and the range guard
// still rejects anything implausible either way.
function mlbPerGame(stats, avgKeys, totalKeys) {
  const opts = { range: [MLB_RATE_MIN, MLB_RATE_MAX], label: avgKeys[0] };
  const gp = parseFloat(stats['gamesPlayed'] ?? stats['GP'] ?? stats['games']);
  if (Number.isFinite(gp) && gp >= 10) {
    for (const k of totalKeys) {
      const v = parseFloat(stats[k]);
      if (!Number.isFinite(v)) continue;
      const derived = v / gp;
      if (derived >= MLB_RATE_MIN && derived <= MLB_RATE_MAX) return derived;
    }
  }
  return perGameStat(stats, avgKeys, { ...opts, totalKeys });
}

async function enrichMLB(espn, teamMap) {
  for (const abbr of Object.keys(teamMap)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams/${abbr}/statistics`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      const stats = flattenESPNStats(data);
      // 2026-08-08 BUGFIX. The old chain checked stats['runs'] FIRST, which is
      // the SEASON TOTAL, not a per-game rate — and thanks to the namespace
      // collision above it was sometimes the pitching category's total anyway.
      // Result: mlb_run_diff ran from -5825 to +4725 when a correct value is
      // roughly +/-0.5. Boston/Athletics computed a raw differential of
      // -23,300 runs. The feature happens to carry zero weight today so it
      // never corrupted a pick, but it meant run differential — commented in
      // game-features.js as "single best predictor in baseball" — has been
      // contributing nothing at all.
      teamMap[abbr].runsPerGame = mlbPerGame(
        stats, ['batting.avgRuns', 'avgRuns', 'runsPerGame'], ['batting.runs', 'runs']);
      teamMap[abbr].runsAllowedPerGame = mlbPerGame(
        stats, ['pitching.avgRunsAllowed', 'avgRunsAllowed', 'runsAllowedPerGame'],
        ['pitching.runs', 'runsAllowed']);
      // 2026-08-08 — team batting/pitching detail. model-params.MLB.json
      // weights ops_diff (0.4), whip_diff (0.45) and batting_avg_diff (0.25)
      // but none were ever collected, so scoreMarket skipped them silently.
      // These are ratios, not counts: no totalKeys, and tight ranges so a
      // wrong ESPN key name degrades to 0 rather than injecting nonsense.
      teamMap[abbr].ops = perGameStat(stats,
        ['batting.OPS', 'batting.onBasePlusSlugging', 'OPS', 'onBasePlusSlugging'],
        { range: [0.4, 1.2], label: 'MLB team OPS', quiet: true });
      teamMap[abbr].battingAvg = perGameStat(stats,
        ['batting.avg', 'batting.battingAverage', 'avg', 'battingAverage'],
        { range: [0.15, 0.35], label: 'MLB team AVG', quiet: true });
      teamMap[abbr].whip = perGameStat(stats,
        ['pitching.WHIP', 'pitching.whip', 'WHIP', 'whip'],
        { range: [0.7, 2.0], label: 'MLB team WHIP', quiet: true });

      // 2026-08-09 DIAGNOSTIC. On the first production run, runsAllowedPerGame
      // resolved correctly (~4.3) while runsPerGame came through at season-
      // total scale (~600) despite an identical resolver and range guard. The
      // code is right on inspection, so the answer is in the actual ESPN
      // payload and not in the source. One team per league is enough to see
      // which key won and what the batting category really contains. Remove
      // once runsPerGame is confirmed stable.
      // 2026-08-10 — written to debug_probe, not console.log. Actions log
      // downloads are outside the dev egress allowlist, so the identical probe
      // added yesterday produced output nobody could read and the runsPerGame
      // question survived another full day. Diagnostics have to land somewhere
      // queryable or they are not diagnostics.
      if (!enrichMLB._probed) {
        enrichMLB._probed = true;
        await probeKeys('data-collection', 'mlb-espn-run-keys', stats,
          /run|game|avg|ops|whip|batting/i, {
            team: abbr,
            resolved_runsPerGame: teamMap[abbr].runsPerGame,
            resolved_runsAllowedPerGame: teamMap[abbr].runsAllowedPerGame,
            resolved_ops: teamMap[abbr].ops,
            resolved_whip: teamMap[abbr].whip,
          });
      }
    } catch (err) {
      // Skip
    }
  }
  console.log('[data-collection] MLB enrichment complete');
}

/**
 * NHL: Pull goals for / goals against per game.
 */
async function enrichNHL(espn, teamMap) {
  for (const abbr of Object.keys(teamMap)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams/${abbr}/statistics`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      const stats = flattenESPNStats(data);
      teamMap[abbr].goalsFor = stats['goalsFor'] || stats['avgGoals'] || stats['goals'] || '';
      teamMap[abbr].goalsAgainst = stats['goalsAgainst'] || stats['avgGoalsAgainst'] || stats['opponentGoals'] || '';
    } catch (err) {
      // Skip
    }
  }
  console.log('[data-collection] NHL enrichment complete');
}

/**
 * NFL: Pull points for / points against.
 */
async function enrichNFL(espn, teamMap) {
  for (const abbr of Object.keys(teamMap)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams/${abbr}/statistics`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      const stats = flattenESPNStats(data);
      // 2026-08-08 — `points` (a season total) used to be a fallback here, the
      // same trap that broke MLB run differential. Range-guarded now.
      teamMap[abbr].pointsFor = perGameStat(stats,
        ['totalPointsPerGame', 'avgPoints'], { totalKeys: ['points', 'totalPoints'],
        range: [5, 45], label: 'NFL points/game', quiet: true });
      teamMap[abbr].pointsAgainst = perGameStat(stats,
        ['avgPointsAgainst', 'pointsAgainstPerGame'],
        { totalKeys: ['pointsAgainst'], range: [5, 45], label: 'NFL points allowed/game', quiet: true });

      // NFL carried the largest remaining dead weight of any league:
      // turnover_impact 1.8, yards_diff 0.45, red_zone_diff 0.35,
      // third_down_diff 0.3, opp_yards_diff 0.3, pass/rush_yards_diff. All
      // weighted, none collected. Percentages are stored as ESPN gives them
      // (0-100) and normalised in game-features.
      teamMap[abbr].yardsPerGame = perGameStat(stats,
        ['totalYardsPerGame', 'yardsPerGame', 'netTotalYardsPerGame'],
        { totalKeys: ['totalYards', 'netTotalYards'], range: [150, 550], label: 'NFL yards/game', quiet: true });
      teamMap[abbr].oppYardsPerGame = perGameStat(stats,
        ['opponentTotalYardsPerGame', 'yardsAllowedPerGame', 'opponentYardsPerGame'],
        { totalKeys: ['opponentTotalYards', 'yardsAllowed'], range: [150, 550], label: 'NFL opp yards/game', quiet: true });
      teamMap[abbr].passYardsPerGame = perGameStat(stats,
        ['netPassingYardsPerGame', 'passingYardsPerGame', 'passYardsPerGame'],
        { totalKeys: ['netPassingYards', 'passingYards'], range: [80, 400], label: 'NFL pass yds/game', quiet: true });
      teamMap[abbr].rushYardsPerGame = perGameStat(stats,
        ['rushingYardsPerGame', 'rushYardsPerGame'],
        { totalKeys: ['rushingYards'], range: [40, 250], label: 'NFL rush yds/game', quiet: true });
      teamMap[abbr].thirdDownPct = perGameStat(stats,
        ['thirdDownConvPct', 'thirdDownConversionPct', 'thirdDownPct'],
        { range: [15, 65], label: 'NFL 3rd down %', quiet: true });
      teamMap[abbr].redZonePct = perGameStat(stats,
        ['redzoneScoringPct', 'redZoneScoringPct', 'redzoneEfficiencyPct'],
        { range: [20, 90], label: 'NFL red zone %', quiet: true });
      // Turnovers: takeaways minus giveaways is the classic NFL margin stat
      // and is what turnover_impact (weight 1.8) is asking for.
      teamMap[abbr].takeaways = perGameStat(stats,
        ['totalTakeaways', 'takeaways', 'defensiveTakeaways'],
        { range: [0, 60], label: 'NFL takeaways', quiet: true });
      teamMap[abbr].giveaways = perGameStat(stats,
        ['totalGiveaways', 'giveaways', 'turnovers'],
        { range: [0, 60], label: 'NFL giveaways', quiet: true });
    } catch (err) {
      // Skip
    }
  }
  console.log('[data-collection] NFL enrichment complete');
}

/**
 * Flatten ESPN statistics response into a simple { statName: value } map.
 * ESPN returns nested categories â statistics arrays. We flatten everything
 * so callers can access by stat name directly.
 */
function flattenESPNStats(data) {
  const result = {};
  try {
    const categories = data?.results?.stats?.categories
      || data?.stats?.categories
      || data?.statistics?.splits?.categories
      || [];

    for (const cat of categories) {
      // 2026-08-08: MLB returns a stat literally named `runs` in BOTH the
      // batting and pitching categories — offense scored vs offense allowed.
      // Flattening every category into one namespace means whichever category
      // ESPN happens to emit last silently wins, so `stats['runs']` could be
      // either. Category-prefixed keys are added alongside the flat ones so a
      // caller can ask for exactly what it means. Flat keys keep last-wins
      // semantics unchanged — this is purely additive and does not alter NBA,
      // NFL or NHL extraction.
      const catName = String(cat.name || cat.abbreviation || '').toLowerCase();
      const stats = cat.stats || cat.statistics || [];
      for (const s of stats) {
        if (s.name && s.value !== undefined) {
          result[s.name] = s.value;
          if (catName) result[`${catName}.${s.name}`] = s.value;
        }
        if (s.abbreviation && s.value !== undefined) {
          result[s.abbreviation] = s.value;
          if (catName) result[`${catName}.${s.abbreviation}`] = s.value;
        }
      }
    }
  } catch (err) {
    // Return empty â caller will use defaults
  }
  return result;
}

// ââ Enrichment: Recent Form (Last 10 Games) ââââââââââââââââââ

/**
 * Fetch recent game results to compute last-10-game form.
 * Uses the scoreboard/events endpoint to get recent completed games.
 */
async function enrichRecentForm(league, espn, teamMap) {
  try {
    // 2026-08-08 BUGFIX — this used to sample only FIVE non-consecutive dates
    // out of a 14-day window ([0],[2],[5],[8],[12]) and gate on games >= 3, so
    // a team's recent form came from 3-5 games. wins/games could then only
    // land on a handful of values: recent_form_*_diff had THREE distinct
    // values (-0.5, 0, +0.5) across every MLB game. Those four features plus
    // momentum_diff are ~90% of the moneyline model's signal, so the model was
    // effectively reading one three-valued number. It also compared two teams
    // over different, non-overlapping sets of games.
    //
    // Now walks consecutive days and keeps results IN ORDER, which also yields
    // genuine L1/L3/L5/L10 windows instead of the synthetic
    // formDiff * {1.0,1.1,1.2,1.3} copies game-features.js was inventing.
    // ESPN scoreboard is free with no published rate limit; we stop early once
    // every team has 10 games.
    const MAX_DAYS_BACK = 20;
    const dates = [];
    for (let i = 1; i <= MAX_DAYS_BACK; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }

    // Track wins/losses per team over this window
    const teamResults = {}; // abbr â [W, L]
    for (const abbr of Object.keys(teamMap)) {
      teamResults[abbr] = { wins: 0, losses: 0, games: 0, seq: [] };
    }

    // Fetch a few recent days' scoreboards to get game results
    // We sample 5 dates spread across the 14-day window to limit API calls
    const allTeamsFull = () => Object.values(teamResults).every((r) => r.games >= 10);

    for (const dateStr of dates) {
      if (allTeamsFull()) break;
      try {
        const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${dateStr}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const data = await res.json();
        const events = data.events || [];

        for (const event of events) {
          if (event.status?.type?.completed !== true) continue;

          const competitors = event.competitions?.[0]?.competitors || [];
          for (const comp of competitors) {
            const abbr = comp.team?.abbreviation || '';
            if (!teamResults[abbr]) continue;
            if (teamResults[abbr].games >= 10) continue; // Cap at 10

            const won = comp.winner === true;
            teamResults[abbr].games++;
            teamResults[abbr].seq.push(won ? 1 : 0);
            if (won) teamResults[abbr].wins++;
            else teamResults[abbr].losses++;
          }
        }
      } catch (err) {
        // Skip date
      }
    }

    const windowRate = (seq, n) => (seq.length >= n
      ? (seq.slice(0, n).reduce((x, y) => x + y, 0) / n).toFixed(3)
      : '');

    // Write results back to teamMap
    for (const [abbr, results] of Object.entries(teamResults)) {
      if (results.games >= 3 && teamMap[abbr]) {
        teamMap[abbr].last10W = results.wins;
        teamMap[abbr].last10L = results.losses;
        teamMap[abbr].recentFormPct = (results.wins / results.games).toFixed(3);
        // A window is emitted only when actually FULL. A "last 5" computed
        // from 2 games is not a last-5, and silently emitting one is exactly
        // how the three-valued feature arose. Consumers fall back to the
        // longest window they really have.
        teamMap[abbr].formL1 = windowRate(results.seq, 1);
        teamMap[abbr].formL3 = windowRate(results.seq, 3);
        teamMap[abbr].formL5 = windowRate(results.seq, 5);
      }
    }
    const seen = Object.values(teamResults).map((r) => r.games);
    console.log(`[data-collection] ${league}: recent form games/team min=${Math.min(...seen)} `
      + `max=${Math.max(...seen)} across ${dates.length} days`);

    console.log(`[data-collection] ${league}: recent form computed for ${Object.keys(teamResults).length} teams`);
  } catch (err) {
    console.warn(`[data-collection] Recent form failed for ${league}:`, err.message);
  }
}

// ââ Schedule / Rest Data âââââââââââââââââââââââââââââââââââââ

/**
 * Fetch today's schedule and compute rest days for each team.
 * Writes to Schedule_Context sheet for game-model to consume.
 *
 * Called as part of trigger2 (after updateTeamStats) or standalone.
 */
async function updateScheduleContext() {
  console.log('[data-collection] Updating schedule context (rest/B2B)...');

  const HEADER = [
    'Timestamp', 'Sport', 'HomeTeam', 'AwayTeam',
    'HomeDaysOff', 'AwayDaysOff', 'HomeB2B', 'AwayB2B',
    'CommenceTime',
  ];
  const allRows = [HEADER];
  const ts = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  for (const [leagueName, espn] of Object.entries(ESPN_SPORTS)) {
    try {
      // Get today's games
      const todayUrl = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${today}`;
      const todayRes = await fetch(todayUrl, { signal: AbortSignal.timeout(15000) });
      if (!todayRes.ok) continue;
      const todayData = await todayRes.json();
      const todayEvents = todayData.events || [];

      if (todayEvents.length === 0) continue;

      // Get yesterday's games to detect back-to-backs
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
      const yestUrl = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${yesterdayStr}`;
      const yestRes = await fetch(yestUrl, { signal: AbortSignal.timeout(15000) });
      const yestData = yestRes.ok ? await yestRes.json() : { events: [] };
      const yestEvents = yestData.events || [];

      // Build set of teams that played yesterday
      const playedYesterday = new Set();
      for (const event of yestEvents) {
        const comps = event.competitions?.[0]?.competitors || [];
        for (const c of comps) {
          if (c.team?.abbreviation) playedYesterday.add(c.team.abbreviation);
        }
      }

      // Get 2 days ago to detect 2-day rest
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysStr = twoDaysAgo.toISOString().slice(0, 10).replace(/-/g, '');
      const twoUrl = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${twoDaysStr}`;
      const twoRes = await fetch(twoUrl, { signal: AbortSignal.timeout(15000) });
      const twoData = twoRes.ok ? await twoRes.json() : { events: [] };
      const twoEvents = twoData.events || [];

      const playedTwoDaysAgo = new Set();
      for (const event of twoEvents) {
        const comps = event.competitions?.[0]?.competitors || [];
        for (const c of comps) {
          if (c.team?.abbreviation) playedTwoDaysAgo.add(c.team.abbreviation);
        }
      }

      // Process today's games
      for (const event of todayEvents) {
        const comps = event.competitions?.[0]?.competitors || [];
        const home = comps.find(c => c.homeAway === 'home');
        const away = comps.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const homeAbbr = home.team?.abbreviation || '';
        const awayAbbr = away.team?.abbreviation || '';

        // Calculate days off
        const homeDaysOff = playedYesterday.has(homeAbbr) ? 0
          : playedTwoDaysAgo.has(homeAbbr) ? 1 : 2;
        const awayDaysOff = playedYesterday.has(awayAbbr) ? 0
          : playedTwoDaysAgo.has(awayAbbr) ? 1 : 2;

        allRows.push([
          ts, leagueName,
          home.team?.displayName || homeAbbr,
          away.team?.displayName || awayAbbr,
          homeDaysOff, awayDaysOff,
          homeDaysOff === 0 ? 'TRUE' : 'FALSE',
          awayDaysOff === 0 ? 'TRUE' : 'FALSE',
          event.date || '',
        ]);
      }

      console.log(`[data-collection] ${leagueName}: schedule context for ${todayEvents.length} games`);
    } catch (err) {
      console.error(`[data-collection] Schedule ${leagueName} error:`, err.message);
    }
  }

  if (SHEETS.SCHEDULE_CONTEXT) {
    await persistSnapshotFirst({
      entity: 'scheduleContext', rows: allRows, mode: dataModeFor('scheduleContext'),
      insertSnapshot: (e, r) => db.insertSnapshot(e, r),
      writeSheet: async () => {
        await clearSheet(SPREADSHEET_ID, SHEETS.SCHEDULE_CONTEXT);
        await setValues(SPREADSHEET_ID, SHEETS.SCHEDULE_CONTEXT, 'A1', allRows);
      },
    });
  }

  console.log(`[data-collection] Schedule context updated: ${allRows.length - 1} games`);
  return allRows;
}

// ââ Odds API ââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Fetch odds from The Odds API and write to GameOdds sheet.
 * Also archives to HistoricalOdds. Used by trigger3.
 */
async function fetchOddsAndGrade() {
  console.log('[data-collection] Fetching odds + grading yesterday...');

  const allOddsRows = [['Timestamp', 'Sport', 'HomeTeam', 'AwayTeam', 'CommenceTime',
    'Market', 'Outcome', 'Price', 'Point', 'BookmakerKey', 'EventId']];
  const ts = new Date().toISOString();

  for (const [sportName, sportConfig] of Object.entries(SPORTS)) {
    try {
      // Bound the fetch to the league's eligibility window. This is the single
      // change that stops pricing the entire NFL/NHL season every day: we only
      // ever see games close enough to matter. max_days_out comes from lock-policy.
      const horizonDays = (LOCK_POLICY[sportName] && LOCK_POLICY[sportName].max_days_out) || 7;
      const nowIso = new Date().toISOString().slice(0, 19) + 'Z';
      const toIso = new Date(Date.now() + horizonDays * 864e5).toISOString().slice(0, 19) + 'Z';
      const params = new URLSearchParams({
        apiKey: ODDS_API_KEY,
        regions: 'us',
        markets: MARKETS.join(','),
        oddsFormat: 'american',
        commenceTimeFrom: nowIso,
        commenceTimeTo: toIso,
      });
      const url = `${ODDS_API_BASE}/sports/${sportConfig.key}/odds?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      logApiCall({ endpoint: `odds/${sportConfig.key}`, costEstimate: ODDS_API_COST_PER_CALL });

      if (!res.ok) {
        console.warn(`Odds API ${sportName}: ${res.status}`);
        continue;
      }
      const events = await res.json();

      for (const event of events) {
        for (const bookmaker of event.bookmakers || []) {
          for (const market of bookmaker.markets || []) {
            for (const outcome of market.outcomes || []) {
              allOddsRows.push([
                ts,
                sportName,
                event.home_team,
                event.away_team,
                event.commence_time,
                market.key,
                outcome.name,
                outcome.price,
                outcome.point || '',
                bookmaker.key,
                event.id || '',
              ]);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[data-collection] Odds API ${sportName} error:`, err.message);
    }
  }

  // Snapshot-first persistence: the durable Supabase shadow is written before the
  // Sheet so a Sheet failure can't leave the migration snapshot stale (the cause
  // of the "Snapshot is stale (53h old)" alert during the OAuth outage).
  await persistGameOdds(allOddsRows, {
    mode: dataModeFor('gameOdds'),
    insertSnapshot: (entity, rows) => db.insertSnapshot(entity, rows),
    clearSheet, setValues, appendRows,
    spreadsheetId: SPREADSHEET_ID,
    gameOddsSheet: SHEETS.GAME_ODDS,
    historicalSheet: SHEETS.HISTORICAL_ODDS,
  });
  console.log(`[data-collection] Odds updated: ${allOddsRows.length - 1} rows`);
}

// ââ Yesterday's Results (Scores API) âââââââââââââââââââââââââ

/**
 * Fetch yesterday's completed game scores from The Odds API.
 * Writes to Yesterday_Results sheet for grading.
 * Used by trigger12 (post-game grading).
 */
async function fetchYesterdayResults() {
  console.log('[data-collection] Fetching recent game results (2-day lookback)...');

  // Look back 2 days to catch late-night games and timezone edge cases
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

  const allRows = [['League', 'GameDate', 'AwayTeam', 'HomeTeam', 'AwayScore', 'HomeScore', 'Status']];
  const seen = new Set(); // Deduplicate games across the 2-day window

  for (const [sportName, sportConfig] of Object.entries(SPORTS)) {
    try {
      const params = new URLSearchParams({
        apiKey: ODDS_API_KEY,
        daysFrom: '2',
      });
      const url = `${ODDS_API_BASE}/sports/${sportConfig.key}/scores?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      logApiCall({ endpoint: `scores/${sportConfig.key}`, costEstimate: ODDS_API_COST_PER_CALL });

      if (!res.ok) {
        console.warn(`Scores API ${sportName}: ${res.status}`);
        continue;
      }
      const games = await res.json();

      for (const game of games) {
        // Accept games from yesterday or the day before
        const gameDate = (game.commence_time || '').split('T')[0];
        if (gameDate !== yesterdayStr && gameDate !== twoDaysAgoStr) continue;

        // Deduplicate using full commence_time (handles doubleheaders)
        const dedupeKey = `${sportName}|${game.away_team}|${game.home_team}|${game.commence_time || gameDate}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // Determine game status
        let status = 'Final';
        if (!game.completed) {
          // Check for canceled/postponed/suspended
          // The Odds API returns completed=false for games not yet played or canceled
          // If the game date is in the past and it's not completed, it was likely postponed
          const now = new Date();
          const gameStart = new Date(game.commence_time);
          const hoursSinceStart = (now - gameStart) / (1000 * 60 * 60);
          if (hoursSinceStart > 6) {
            // Game should have finished by now — likely postponed or canceled
            status = 'Postponed';
            console.log(`[data-collection] ${sportName}: ${game.away_team} @ ${game.home_team} appears postponed (${game.commence_time}, ${hoursSinceStart.toFixed(0)}h ago, not completed)`);
          } else {
            // Game hasn't started yet or is in progress — skip
            continue;
          }
        }

        const scores = game.scores || [];
        const homeData = scores.find(s => s.name === game.home_team) || {};
        const awayData = scores.find(s => s.name === game.away_team) || {};

        allRows.push([
          sportName,
          game.commence_time || '',
          game.away_team || '',
          game.home_team || '',
          status === 'Final' ? (parseFloat(awayData.score) || 0) : '',
          status === 'Final' ? (parseFloat(homeData.score) || 0) : '',
          status,
        ]);
      }
      console.log(`[data-collection] ${sportName}: found ${allRows.length - 1} games (completed + postponed)`);
    } catch (err) {
      console.error(`[data-collection] Scores API ${sportName} error:`, err.message);
    }
  }

  await persistSnapshotFirst({
    entity: 'yesterdayResults', rows: allRows, mode: dataModeFor('yesterdayResults'),
    insertSnapshot: (e, r) => db.insertSnapshot(e, r),
    writeSheet: async () => {
      await clearSheet(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS);
      await setValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS, 'A1', allRows);
    },
  });
  console.log(`[data-collection] Results updated: ${allRows.length - 1} games (2-day window)`);

  return allRows.length - 1;
}


/**
 * Fetch injury reports from ESPN for all 4 leagues and write to Injury Summary sheet.
 * ESPN's /injuries endpoint returns current team injury reports with player status.
 * 
 * Output format: [Timestamp, League, Team, Player, Status, Position, Impact]
 * Called by trigger2 (daily stats) to ensure injury data is fresh before predictions.
 */
async function fetchInjuryReports() {
  console.log('[data-collection] Fetching injury reports from ESPN...');
  const ts = new Date().toISOString().split('T')[0];
  const HEADER = ['Timestamp', 'League', 'Team', 'Player', 'Status', 'Position', 'Impact'];
  const allRows = [HEADER];

  for (const [label, { sport, league }] of Object.entries(ESPN_SPORTS)) {
    try {
      // ESPN injuries endpoint: returns per-team injury lists
      const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/injuries`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        console.warn(`[data-collection] ESPN ${label} injuries returned ${res.status}`);
        continue;
      }
      const data = await res.json();

      // ESPN response structure: { injuries: [{ team: {...}, injuries: [{...}] }] }
      // OR alternate: { resultSets: [...] } or league-specific variations
      const teamInjuries = data.injuries || data.resultSets || [];

      for (const teamEntry of teamInjuries) {
        const teamData = teamEntry.team || {};
        const teamAbbr = teamData.abbreviation || teamData.abbrev || '';
        const injuries = teamEntry.injuries || teamEntry.items || [];

        for (const inj of injuries) {
          const athlete = inj.athlete || {};
          const playerName = athlete.displayName || athlete.fullName || '';
          const status = (inj.status || inj.type?.description || '').toLowerCase();
          const position = athlete.position?.abbreviation || '';

          // Skip healthy/active players
          if (!playerName || status === 'active' || status === 'healthy') continue;

          // Map ESPN status to our severity scale
          let impact = 0.3; // default moderate
          if (status.includes('out') || status === 'injured reserve' || status === 'suspension') impact = 1.0;
          else if (status.includes('doubtful')) impact = 0.75;
          else if (status.includes('questionable')) impact = 0.5;
          else if (status.includes('probable') || status.includes('day-to-day')) impact = 0.2;

          allRows.push([ts, label, teamAbbr, playerName, status, position, impact]);
        }
      }

      console.log(`[data-collection] ${label}: ${allRows.filter(r => r[1] === label).length} injury entries`);
    } catch (err) {
      console.error(`[data-collection] ESPN ${label} injuries error:`, err.message);
    }
  }

  // Write to Injury Summary sheet (overwrite — fresh daily snapshot)
  if (allRows.length > 1) {
    await persistSnapshotFirst({
      entity: 'injuries', rows: allRows, mode: dataModeFor('injuries'),
      insertSnapshot: (e, r) => db.insertSnapshot(e, r),
      writeSheet: async () => {
        await ensureSheet(SPREADSHEET_ID, SHEETS.INJURY_SUMMARY);
        await clearSheet(SPREADSHEET_ID, SHEETS.INJURY_SUMMARY);
        await setValues(SPREADSHEET_ID, SHEETS.INJURY_SUMMARY, 'A1', allRows);
      },
    });
    console.log(`[data-collection] Injury reports updated: ${allRows.length - 1} entries across 4 leagues`);
  } else {
    console.log('[data-collection] No injury data retrieved from ESPN');
  }

  return allRows.length - 1;
}

module.exports = {
  updatePlayerStats,
  updateTeamStats,
  updateScheduleContext,
  fetchOddsAndGrade,
  fetchYesterdayResults,
  fetchInjuryReports,
};
