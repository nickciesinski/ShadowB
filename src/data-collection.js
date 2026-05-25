'use strict';
// =============================================================
// src/data-collection.js â ESPN + Odds API fetching & grading
// Replaces: Data Collection (Apps Script)
//
// Sprint 2 (April 2026): Expanded team stats â off/def ratings,
// pace, scoring averages, recent form, rest/schedule data.
// =============================================================

const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, ODDS_API_BASE, SPORTS, MARKETS } = require('./config');
const { getValues, setValues, appendRows, clearSheet, ensureSheet } = require('./sheets');
const { logApiCall } = require('./monitoring');

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
 */
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
      teamMap[abbr].offRating = stats['offensiveRating'] || stats['avgPoints'] || '';
      teamMap[abbr].defRating = stats['defensiveRating'] || stats['avgPointsAgainst'] || '';
      teamMap[abbr].pace = stats['pace'] || stats['possessions'] || '';
      teamMap[abbr].pointsFor = stats['avgPoints'] || stats['points'] || '';
      teamMap[abbr].pointsAgainst = stats['avgPointsAgainst'] || stats['opponentPoints'] || '';
    } catch (err) {
      // Skip individual team failures silently
    }
  }
  console.log('[data-collection] NBA enrichment complete');
}

/**
 * MLB: Pull runs scored / runs allowed per game.
 */
async function enrichMLB(espn, teamMap) {
  for (const abbr of Object.keys(teamMap)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams/${abbr}/statistics`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();
      const stats = flattenESPNStats(data);
      teamMap[abbr].runsPerGame = stats['runs'] || stats['avgRuns'] || stats['runsPerGame'] || '';
      teamMap[abbr].runsAllowedPerGame = stats['runsAllowed'] || stats['avgRunsAllowed'] || stats['runsAllowedPerGame'] || '';
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
      teamMap[abbr].pointsFor = stats['totalPointsPerGame'] || stats['avgPoints'] || stats['points'] || '';
      teamMap[abbr].pointsAgainst = stats['pointsAgainst'] || stats['avgPointsAgainst'] || '';
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
      const stats = cat.stats || cat.statistics || [];
      for (const s of stats) {
        if (s.name && s.value !== undefined) {
          result[s.name] = s.value;
        }
        if (s.abbreviation && s.value !== undefined) {
          result[s.abbreviation] = s.value;
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
    // Fetch last 10 days of scores to approximate recent form
    const dates = [];
    for (let i = 1; i <= 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }

    // Track wins/losses per team over this window
    const teamResults = {}; // abbr â [W, L]
    for (const abbr of Object.keys(teamMap)) {
      teamResults[abbr] = { wins: 0, losses: 0, games: 0 };
    }

    // Fetch a few recent days' scoreboards to get game results
    // We sample 5 dates spread across the 14-day window to limit API calls
    const sampleDates = [dates[0], dates[2], dates[5], dates[8], dates[12]].filter(Boolean);

    for (const dateStr of sampleDates) {
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
            if (won) teamResults[abbr].wins++;
            else teamResults[abbr].losses++;
          }
        }
      } catch (err) {
        // Skip date
      }
    }

    // Write results back to teamMap
    for (const [abbr, results] of Object.entries(teamResults)) {
      if (results.games >= 3 && teamMap[abbr]) {
        teamMap[abbr].last10W = results.wins;
        teamMap[abbr].last10L = results.losses;
        teamMap[abbr].recentFormPct = (results.wins / results.games).toFixed(3);
      }
    }

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
    await clearSheet(SPREADSHEET_ID, SHEETS.SCHEDULE_CONTEXT);
    await setValues(SPREADSHEET_ID, SHEETS.SCHEDULE_CONTEXT, 'A1', allRows);
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
    'Market', 'Outcome', 'Price', 'Point', 'BookmakerKey']];
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

  await clearSheet(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS);
  await setValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS, 'A1', allRows);
  console.log(`[data-collection] Results updated: ${allRows.length - 1} games (2-day window)`);

  return allRows.length - 1;
}

module.exports = {
  updatePlayerStats,
  updateTeamStats,
  updateScheduleContext,
  fetchOddsAndGrade,
  fetchYesterdayResults,
};
