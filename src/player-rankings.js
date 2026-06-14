'use strict';
// =============================================================
// src/player-rankings.js — Player Rankings System
//
// Reads rosters (with ESPN IDs) from main Shadow Bets spreadsheet,
// fetches per-player stats from ESPN athlete endpoint,
// computes z-score composite rankings per position group,
// writes summary + detail sheets to separate Player Stats spreadsheet.
// =============================================================

const { SPREADSHEET_ID, SHEETS } = require('./config');
const { getValues, setValues, clearSheet, ensureSheet } = require('./sheets');
const dataStore = require('./data-store');

// New spreadsheet for rankings output
const RANKINGS_SPREADSHEET_ID = process.env.RANKINGS_SPREADSHEET_ID || '';

// ── Config ─────────────────────────────────────────────────────

const PR_CONFIG = {

  // Composite score cutoffs for tier assignment (5 tiers)
  tierThresholds: [
    { tier: 1, minScore: 85 },   // Elite
    { tier: 2, minScore: 68 },   // Above Average
    { tier: 3, minScore: 50 },   // Average
    { tier: 4, minScore: 32 },   // Below Average
    { tier: 5, minScore: 0 },    // Replacement
  ],

  // % of composite score from volume vs rate stats per sport/position group
  statWeights: {
    MLB_BATTER:  { volume: 0.35, rate: 0.65 },
    MLB_PITCHER: { volume: 0.30, rate: 0.70 },
    NHL_SKATER:  { volume: 0.40, rate: 0.60 },
    NHL_GOALIE:  { volume: 0.35, rate: 0.65 },
    NBA:         { volume: 0.30, rate: 0.70 },
    NFL_QB:      { volume: 0.35, rate: 0.65 },
    NFL_SKILL:   { volume: 0.40, rate: 0.60 },
    NFL_DEF:     { volume: 0.40, rate: 0.60 },
  },

  // Stats to extract from ESPN athlete responses, per position group.
  // key = ESPN stat name (what the API returns), display = column header.
  // invert = true means lower is better (ERA, WHIP, GAA, turnovers, etc.)
  stats: {
    MLB_BATTER: {
      volume: [
        { key: 'homeRuns', display: 'HR' },
        { key: 'RBIs', display: 'RBI' },
        { key: 'hits', display: 'H' },
        { key: 'runs', display: 'R' },
        { key: 'stolenBases', display: 'SB' },
        { key: 'doubles', display: '2B' },
      ],
      rate: [
        { key: 'avg', display: 'AVG' },
        { key: 'onBasePct', display: 'OBP' },
        { key: 'slugAvg', display: 'SLG' },
        { key: 'OPS', display: 'OPS' },
        { key: 'WARBR', display: 'WAR' },
      ],
    },
    MLB_PITCHER: {
      volume: [
        { key: 'wins', display: 'W' },
        { key: 'losses', display: 'L' },
        { key: 'strikeouts', display: 'SO' },
        { key: 'saves', display: 'SV' },
        { key: 'innings', display: 'IP' },
        { key: 'holds', display: 'HLD' },
      ],
      rate: [
        { key: 'ERA', display: 'ERA', invert: true },
        { key: 'WHIP', display: 'WHIP', invert: true },
        { key: 'strikeoutsPerNineInnings', display: 'K/9' },
        { key: 'strikeoutToWalkRatio', display: 'K/BB' },
        { key: 'winPct', display: 'W%' },
      ],
    },
    NHL_SKATER: {
      volume: [
        { key: 'goals', display: 'G' },
        { key: 'assists', display: 'A' },
        { key: 'points', display: 'PTS' },
        { key: 'powerPlayGoals', display: 'PPG' },
        { key: 'powerPlayAssists', display: 'PPA' },
        { key: 'gameWinningGoals', display: 'GWG' },
      ],
      rate: [
        { key: 'plusMinus', display: '+/-' },
        { key: 'timeOnIcePerGame', display: 'TOI/GP' },
        { key: 'production', display: 'P/GP' },
        { key: 'shootingPct', display: 'SH%' },
      ],
    },
    NHL_GOALIE: {
      volume: [
        { key: 'wins', display: 'W' },
        { key: 'losses', display: 'L' },
        { key: 'shutouts', display: 'SO' },
        { key: 'games', display: 'GP' },
        { key: 'saves', display: 'Saves' },
      ],
      rate: [
        { key: 'savePct', display: 'SV%' },
        { key: 'goalsAgainstAverage', display: 'GAA', invert: true },
      ],
    },
    NBA: {
      volume: [
        { key: 'avgPoints', display: 'PTS' },
        { key: 'avgRebounds', display: 'REB' },
        { key: 'avgAssists', display: 'AST' },
        { key: 'avgSteals', display: 'STL' },
        { key: 'avgBlocks', display: 'BLK' },
        { key: 'avgMinutes', display: 'MIN' },
        { key: 'gamesPlayed', display: 'GP' },
      ],
      rate: [
        { key: 'fieldGoalPct', display: 'FG%' },
        { key: 'threePointFieldGoalPct', display: '3P%' },
        { key: 'freeThrowPct', display: 'FT%' },
        { key: 'avgTurnovers', display: 'TOV', invert: true },
      ],
    },
    NFL_QB: {
      volume: [
        { key: 'passingYards', display: 'Pass Yds' },
        { key: 'passingTouchdowns', display: 'Pass TD' },
        { key: 'rushingYards', display: 'Rush Yds' },
        { key: 'rushingTouchdowns', display: 'Rush TD' },
      ],
      rate: [
        { key: 'QBRating', display: 'Passer Rtg' },
        { key: 'completionPct', display: 'Comp%' },
        { key: 'yardsPerPassAttempt', display: 'Y/A' },
        { key: 'interceptions', display: 'INT', invert: true },
      ],
    },
    NFL_SKILL: {
      volume: [
        { key: 'rushingYards', display: 'Rush Yds' },
        { key: 'rushingTouchdowns', display: 'Rush TD' },
        { key: 'receivingYards', display: 'Rec Yds' },
        { key: 'receptions', display: 'Rec' },
        { key: 'receivingTouchdowns', display: 'Rec TD' },
      ],
      rate: [
        { key: 'yardsPerRushAttempt', display: 'YPC' },
        { key: 'yardsPerReception', display: 'Y/Rec' },
        { key: 'fumbles', display: 'Fum', invert: true },
      ],
    },
    NFL_DEF: {
      volume: [
        { key: 'totalTackles', display: 'Tackles' },
        { key: 'sacks', display: 'Sacks' },
        { key: 'tacklesForLoss', display: 'TFL' },
        { key: 'interceptions', display: 'INT' },
        { key: 'passesDefended', display: 'PD' },
        { key: 'forcedFumbles', display: 'FF' },
      ],
      rate: [], // ESPN doesn't have defensive rate stats
    },
  },

  // Position → position group mapping
  positionGroups: {
    MLB: {
      SP: 'MLB_PITCHER', RP: 'MLB_PITCHER', CP: 'MLB_PITCHER', CL: 'MLB_PITCHER', P: 'MLB_PITCHER',
      C: 'MLB_BATTER', '1B': 'MLB_BATTER', '2B': 'MLB_BATTER', SS: 'MLB_BATTER',
      '3B': 'MLB_BATTER', LF: 'MLB_BATTER', CF: 'MLB_BATTER', RF: 'MLB_BATTER',
      OF: 'MLB_BATTER', DH: 'MLB_BATTER', IF: 'MLB_BATTER', UT: 'MLB_BATTER',
    },
    NHL: {
      C: 'NHL_SKATER', LW: 'NHL_SKATER', RW: 'NHL_SKATER', F: 'NHL_SKATER',
      D: 'NHL_SKATER', G: 'NHL_GOALIE',
    },
    NBA: {
      PG: 'NBA', SG: 'NBA', SF: 'NBA', PF: 'NBA', C: 'NBA',
      G: 'NBA', F: 'NBA',
    },
    NFL: {
      QB: 'NFL_QB',
      RB: 'NFL_SKILL', WR: 'NFL_SKILL', TE: 'NFL_SKILL', FB: 'NFL_SKILL',
      OL: 'NFL_SKILL', OT: 'NFL_SKILL', OG: 'NFL_SKILL', C: 'NFL_SKILL',
      DL: 'NFL_DEF', DE: 'NFL_DEF', DT: 'NFL_DEF', NT: 'NFL_DEF',
      LB: 'NFL_DEF', OLB: 'NFL_DEF', ILB: 'NFL_DEF',
      CB: 'NFL_DEF', S: 'NFL_DEF', FS: 'NFL_DEF', SS: 'NFL_DEF', DB: 'NFL_DEF',
      K: 'NFL_SKILL', P: 'NFL_SKILL',
    },
  },

  // Display position groups for the summary sheet
  displayPositionGroup: {
    MLB_BATTER: 'Batter', MLB_PITCHER: 'Pitcher',
    NHL_SKATER: 'Skater', NHL_GOALIE: 'Goalie',
    NBA: 'All',
    NFL_QB: 'QB', NFL_SKILL: 'Skill', NFL_DEF: 'Defense',
  },

  // NFL QB scale multiplier (pushes elite QBs to top of unified list)
  nflQbScaleMultiplier: 1.12,

  // Sheet names in the RANKINGS spreadsheet
  rankingSheets: {
    MLB_SUMMARY: 'MLB Rankings',
    NHL_SUMMARY: 'NHL Rankings',
    NBA_SUMMARY: 'NBA Rankings',
    NFL_SUMMARY: 'NFL Rankings',
    MLB_BATTING: 'MLB Batting Stats',
    MLB_PITCHING: 'MLB Pitching Stats',
    NHL_SKATERS: 'NHL Skater Stats',
    NHL_GOALIES: 'NHL Goalie Stats',
    NBA_STATS: 'NBA Stats',
    NFL_QB: 'NFL QB Stats',
    NFL_SKILL: 'NFL Skill Stats',
    NFL_DEF: 'NFL Def Stats',
  },

  // Rate limiting: pause between batches of athlete fetches
  fetchBatchSize: 25,
  fetchBatchPauseMs: 1000,

  // Max roster size per sport (safety valve against bloated sheets)
  maxRosterPerSport: 1500,
};

// ── ESPN Sport Config ──────────────────────────────────────────

const ESPN_SPORT_MAP = {
  MLB: { sport: 'baseball', league: 'mlb' },
  NBA: { sport: 'basketball', league: 'nba' },
  NHL: { sport: 'hockey', league: 'nhl' },
  NFL: { sport: 'football', league: 'nfl' },
};

// ── Roster Reading ────────────────────────────────────────────

/**
 * Read roster from existing player sheet in main Shadow Bets spreadsheet.
 * Returns array of { name, team, league, pos, espnId, jersey }
 *
 * Sheet schema: Name(A), Team(B), League(C), Position(D), ESPN_ID(E), Jersey(F)
 */
async function readRoster(sport) {
  const sheetKey = `${sport}_PLAYERS`;
  const sheetName = SHEETS[sheetKey];
  if (!sheetName) {
    console.warn(`[player-rankings] No sheet configured for ${sheetKey}`);
    return [];
  }

  try {
    const rows = await getValues(SPREADSHEET_ID, sheetName);
    if (!rows || rows.length < 2) return [];

    const players = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = (row[0] || '').trim();
      const team = (row[1] || '').trim();
      const pos = (row[3] || '').trim();
      const espnId = (row[4] || '').toString().trim();

      if (!name || !espnId) continue;

      players.push({ name, team, league: sport, pos, espnId });
    }

    // Cap roster size to avoid rate-limiting on large historical rosters
    const cap = PR_CONFIG.maxRosterPerSport;
    if (players.length > cap) {
      console.log(`[player-rankings] ${sport}: capping roster from ${players.length} to ${cap}`);
      players.length = cap;
    }

    console.log(`[player-rankings] ${sport}: read ${players.length} players from roster`);
    return players;
  } catch (err) {
    console.error(`[player-rankings] Failed to read ${sport} roster:`, err.message);
    return [];
  }
}

// ── ESPN Per-Athlete Stats Fetching ───────────────────────────

/**
 * Flatten ESPN athlete statistics response into { statName: value } map.
 * ESPN returns nested categories > splits > stats arrays.
 * We try multiple response shapes since ESPN varies by sport.
 */
/**
 * Parse stats from ESPN common/v3 /stats endpoint.
 * Response shape: { categories: [ { name, names: [...statNames], statistics: [ { season, stats: [...values] } ] } ] }
 * Uses parallel arrays: names[i] corresponds to statistics[last].stats[i].
 * We take the most recent season entry.
 */
function flattenAthleteStats(data) {
  const result = {};

  // ── Shape A: /stats endpoint — parallel arrays in categories ──
  const cats = data?.categories;
  if (cats) {
    const catArr = Array.isArray(cats) ? cats : Object.values(cats);
    for (const cat of catArr) {
      const catName = (cat.name || '').toLowerCase();
      // Only use regular-season career stats (skip postseason, expanded, advanced for now)
      // Career batting/pitching = current-season last entry; position-named cats (center, goalie, etc.) also fine
      if (catName.includes('postseason')) continue;

      const names = cat.names;
      const seasons = cat.statistics;
      if (!names || !seasons || !seasons.length) continue;

      // Take the most recent season
      const latest = seasons[seasons.length - 1];
      if (!latest?.stats) continue;

      for (let i = 0; i < names.length; i++) {
        const val = parseFloat(latest.stats[i]);
        if (!isNaN(val)) {
          result[names[i]] = val;
        }
      }
    }
  }

  // ── Shape B: statsSummary from base athlete endpoint — array of { name, value } objects ──
  const summary = data?.athlete?.statsSummary?.statistics || data?.statsSummary?.statistics;
  if (summary && Array.isArray(summary)) {
    for (const s of summary) {
      if (s.name && s.value !== undefined && s.value !== null) {
        const val = parseFloat(s.value);
        if (!isNaN(val) && !(s.name in result)) {
          result[s.name] = val;
        }
      }
    }
  }

  return result;
}

/**
 * Fetch stats for a single player from ESPN athlete endpoint.
 * Returns { name, team, pos, espnId, stats: { statName: value }, age }
 */
async function fetchAthleteStats(player, sport) {
  const espn = ESPN_SPORT_MAP[sport];
  if (!espn || !player.espnId) return null;

  try {
    const statsUrl = `https://site.web.api.espn.com/apis/common/v3/sports/${espn.sport}/${espn.league}/athletes/${player.espnId}/stats`;
    const statsRes = await fetch(statsUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.espn.com',
        'Referer': 'https://www.espn.com/',
      },
    });

    if (!statsRes.ok) {
      // Track error types for diagnostics
      if (!fetchAthleteStats._errors) fetchAthleteStats._errors = {};
      const code = statsRes.status;
      fetchAthleteStats._errors[code] = (fetchAthleteStats._errors[code] || 0) + 1;
      return null;
    }

    const statsData = await statsRes.json();
    const stats = flattenAthleteStats(statsData);

    if (Object.keys(stats).length === 0) return null;

    player.stats = stats;
    return player;
  } catch (err) {
    if (!fetchAthleteStats._errors) fetchAthleteStats._errors = {};
    fetchAthleteStats._errors['timeout'] = (fetchAthleteStats._errors['timeout'] || 0) + 1;
    return null;
  }
}

/**
 * Fetch stats for all players in a sport roster.
 * Batches requests with pauses to be respectful to ESPN API.
 */
async function fetchAllPlayerStats(roster, sport) {
  const batchSize = PR_CONFIG.fetchBatchSize;
  const pauseMs = PR_CONFIG.fetchBatchPauseMs;
  let fetched = 0;
  let withStats = 0;

  for (let i = 0; i < roster.length; i += batchSize) {
    const batch = roster.slice(i, i + batchSize);

    // Fetch batch in parallel
    const results = await Promise.allSettled(
      batch.map(p => fetchAthleteStats(p, sport))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        fetched++;
        if (Object.keys(r.value.stats || {}).length > 0) withStats++;
      }
    }

    // Rate limit between batches
    if (i + batchSize < roster.length) {
      await new Promise(r => setTimeout(r, pauseMs));
    }

    // Progress log every 100 players
    if ((i + batchSize) % 100 < batchSize) {
      console.log(`[player-rankings] ${sport}: ${i + batchSize}/${roster.length} athletes fetched...`);
    }
  }

  console.log(`[player-rankings] ${sport}: ${fetched} fetched, ${withStats} with stats out of ${roster.length} total`);

  // Log any HTTP errors encountered
  if (fetchAthleteStats._errors && Object.keys(fetchAthleteStats._errors).length > 0) {
    console.log(`[player-rankings] ${sport} fetch errors: ${JSON.stringify(fetchAthleteStats._errors)}`);
    fetchAthleteStats._errors = {};  // Reset for next sport
  }

  // Diagnostic: log available stat keys for first player that has stats
  const samplePlayer = roster.find(p => p.stats && Object.keys(p.stats).length > 0);
  if (samplePlayer) {
    console.log(`[player-rankings] ${sport} sample stat keys (${samplePlayer.name}): ${Object.keys(samplePlayer.stats).join(', ')}`);
  }

  // Filter to only players that have at least some stats
  return roster.filter(p => p.stats && Object.keys(p.stats).length > 0);
}

// ── Z-Score Normalization ─────────────────────────────────────

/**
 * Z-score normalize an array of values to 0-100 scale.
 * If invert=true, lower values are better (ERA, WHIP, GAA, etc.)
 */
function normalizeZScore(values, invert = false) {
  const valid = values.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (valid.length < 3) {
    return values.map(v => (v === null || v === undefined || isNaN(v)) ? null : 50);
  }

  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return values.map(v => (v === null || v === undefined || isNaN(v)) ? null : 50);
  }

  return values.map(v => {
    if (v === null || v === undefined || isNaN(v)) return null;
    let z = (v - mean) / stdDev;
    if (invert) z = -z;
    z = Math.max(-3, Math.min(3, z));   // Cap at ±3 std devs
    return ((z + 3) / 6) * 100;         // Scale 0-100
  });
}

// ── Composite Scoring ─────────────────────────────────────────

/**
 * Compute composite scores for a group of players in the same position group.
 * Mutates each player object to add compositeScore.
 */
function computeCompositeScores(players, posGroup) {
  const statDefs = PR_CONFIG.stats[posGroup];
  const weights = PR_CONFIG.statWeights[posGroup];

  if (!statDefs || !weights) {
    console.warn(`[player-rankings] No stat config for: ${posGroup}`);
    players.forEach(p => { p.compositeScore = 30; });
    return;
  }

  // Find which stats actually have data across these players
  const allStatKeys = [];
  const statMeta = {};

  for (const cat of ['volume', 'rate']) {
    const defs = statDefs[cat] || [];
    for (const def of defs) {
      const hasData = players.some(p => {
        const v = p.stats?.[def.key];
        return v !== null && v !== undefined && !isNaN(v);
      });
      if (hasData && !statMeta[def.key]) {
        allStatKeys.push(def.key);
        statMeta[def.key] = {
          category: cat,
          invert: def.invert || false,
          display: def.display,
        };
      }
    }
  }

  if (allStatKeys.length === 0) {
    console.warn(`[player-rankings] No stat data found for ${posGroup} (${players.length} players)`);
    players.forEach(p => { p.compositeScore = 30; });
    return;
  }

  console.log(`[player-rankings] ${posGroup}: scoring on ${allStatKeys.length} stats — ${allStatKeys.join(', ')}`);

  // Z-score normalize each stat
  const normalizedStats = {};
  for (const key of allStatKeys) {
    const rawValues = players.map(p => {
      const v = p.stats?.[key];
      return (v !== null && v !== undefined && !isNaN(parseFloat(v))) ? parseFloat(v) : null;
    });
    normalizedStats[key] = normalizeZScore(rawValues, statMeta[key].invert);
  }

  // Compute composite per player
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    let volumeSum = 0, volumeCount = 0;
    let rateSum = 0, rateCount = 0;

    for (const key of allStatKeys) {
      const norm = normalizedStats[key][i];
      if (norm === null) continue;
      if (statMeta[key].category === 'volume') { volumeSum += norm; volumeCount++; }
      else { rateSum += norm; rateCount++; }
    }

    const volumeAvg = volumeCount > 0 ? volumeSum / volumeCount : 50;
    const rateAvg = rateCount > 0 ? rateSum / rateCount : 50;

    let composite = (volumeAvg * (weights.volume || 0.4)) + (rateAvg * (weights.rate || 0.6));

    // NFL QB multiplier
    if (posGroup === 'NFL_QB') composite *= PR_CONFIG.nflQbScaleMultiplier;

    player.compositeScore = Math.max(0, Math.min(100, composite));
  }
}

/**
 * Assign tier (1-5) from composite score.
 */
function assignTier(score) {
  for (const { tier, minScore } of PR_CONFIG.tierThresholds) {
    if (score >= minScore) return tier;
  }
  return 5;
}

// ── Injury Integration ────────────────────────────────────────

async function loadInjuryData() {
  const injuryMap = {};
  try {
    const rows = await dataStore.read('injuries');
    if (!rows || rows.length < 2) return injuryMap;
    for (let i = 1; i < rows.length; i++) {
      const name = (rows[i][1] || '').trim();
      const status = (rows[i][3] || '').trim();
      if (name && status) injuryMap[name.toLowerCase()] = status;
    }
    console.log(`[player-rankings] Loaded ${Object.keys(injuryMap).length} injury records`);
  } catch (e) {
    console.warn('[player-rankings] Could not load injury data:', e.message);
  }
  return injuryMap;
}

// ── Sheet Writing ─────────────────────────────────────────────

const SUMMARY_HEADER = [
  'Player Name', 'Team', 'Position', 'Position Group',
  'Composite Score', 'Tier', 'Overall Rank',
  'Injury Status', 'Frozen Score', 'Frozen Rank',
  'Age', 'Last Updated',
];

async function writeSummarySheet(sheetName, players, injuryMap) {
  const ts = new Date().toISOString().split('T')[0];

  // Read existing frozen data
  let frozenMap = {};
  try {
    const existing = await getValues(RANKINGS_SPREADSHEET_ID, sheetName);
    if (existing && existing.length > 1) {
      for (let i = 1; i < existing.length; i++) {
        const name = existing[i][0] || '';
        const frozenScore = existing[i][8] || '';
        const frozenRank = existing[i][9] || '';
        if (name && frozenScore) frozenMap[name] = { frozenScore, frozenRank };
      }
    }
  } catch (e) { /* Sheet may not exist yet */ }

  // Sort by composite score descending
  const sorted = [...players].sort((a, b) => b.compositeScore - a.compositeScore);

  const rows = [SUMMARY_HEADER];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const rank = i + 1;
    const injury = injuryMap[p.name.toLowerCase()] || '';
    const tier = assignTier(p.compositeScore);

    let frozenScore = '', frozenRank = '';
    if (injury) {
      const existing = frozenMap[p.name];
      if (existing?.frozenScore) {
        frozenScore = existing.frozenScore;
        frozenRank = existing.frozenRank;
      } else {
        frozenScore = p.compositeScore.toFixed(1);
        frozenRank = rank;
      }
    }

    rows.push([
      p.name, p.team, p.pos,
      PR_CONFIG.displayPositionGroup[p.posGroup] || p.posGroup,
      p.compositeScore.toFixed(1), tier, rank,
      injury, frozenScore, frozenRank,
      p.age || '', ts,
    ]);
  }

  await ensureSheet(RANKINGS_SPREADSHEET_ID, sheetName);
  await clearSheet(RANKINGS_SPREADSHEET_ID, sheetName);
  await setValues(RANKINGS_SPREADSHEET_ID, sheetName, 'A1', rows);
  console.log(`[player-rankings] Wrote ${rows.length - 1} players to ${sheetName}`);
}

async function writeDetailSheet(sheetName, players, posGroup) {
  const statDefs = PR_CONFIG.stats[posGroup];
  if (!statDefs) return;

  const statColumns = [];
  for (const cat of ['volume', 'rate']) {
    for (const def of (statDefs[cat] || [])) statColumns.push(def);
  }

  const header = ['Player Name', 'Team', 'Position', 'Score', ...statColumns.map(s => s.display)];
  const rows = [header];

  const sorted = [...players].sort((a, b) => b.compositeScore - a.compositeScore);
  for (const p of sorted) {
    const row = [p.name, p.team, p.pos, p.compositeScore.toFixed(1)];
    for (const stat of statColumns) {
      const val = p.stats?.[stat.key];
      row.push(val !== null && val !== undefined && !isNaN(val) ? val : '');
    }
    rows.push(row);
  }

  await ensureSheet(RANKINGS_SPREADSHEET_ID, sheetName);
  await clearSheet(RANKINGS_SPREADSHEET_ID, sheetName);
  await setValues(RANKINGS_SPREADSHEET_ID, sheetName, 'A1', rows);
  console.log(`[player-rankings] Wrote ${rows.length - 1} rows to ${sheetName}`);
}

// ── Per-Sport Update Functions ────────────────────────────────

async function updateMLBRankings(injuryMap) {
  console.log('[player-rankings] === MLB ===');
  const roster = await readRoster('MLB');
  if (roster.length === 0) return 0;

  const playersWithStats = await fetchAllPlayerStats(roster, 'MLB');
  const batters = [], pitchers = [];

  for (const p of playersWithStats) {
    const group = PR_CONFIG.positionGroups.MLB[p.pos] || 'MLB_BATTER';
    p.posGroup = group;
    if (group === 'MLB_PITCHER') pitchers.push(p);
    else batters.push(p);
  }

  if (batters.length > 0) computeCompositeScores(batters, 'MLB_BATTER');
  if (pitchers.length > 0) computeCompositeScores(pitchers, 'MLB_PITCHER');

  const all = [...batters, ...pitchers];
  await writeSummarySheet(PR_CONFIG.rankingSheets.MLB_SUMMARY, all, injuryMap);
  if (batters.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.MLB_BATTING, batters, 'MLB_BATTER');
  if (pitchers.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.MLB_PITCHING, pitchers, 'MLB_PITCHER');

  console.log(`[player-rankings] MLB done: ${batters.length} batters, ${pitchers.length} pitchers`);
  return all.length;
}

async function updateNHLRankings(injuryMap) {
  console.log('[player-rankings] === NHL ===');
  const roster = await readRoster('NHL');
  if (roster.length === 0) return 0;

  const playersWithStats = await fetchAllPlayerStats(roster, 'NHL');
  const skaters = [], goalies = [];

  for (const p of playersWithStats) {
    const group = PR_CONFIG.positionGroups.NHL[p.pos] || 'NHL_SKATER';
    p.posGroup = group;
    if (group === 'NHL_GOALIE') goalies.push(p);
    else skaters.push(p);
  }

  if (skaters.length > 0) computeCompositeScores(skaters, 'NHL_SKATER');
  if (goalies.length > 0) computeCompositeScores(goalies, 'NHL_GOALIE');

  const all = [...skaters, ...goalies];
  await writeSummarySheet(PR_CONFIG.rankingSheets.NHL_SUMMARY, all, injuryMap);
  if (skaters.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.NHL_SKATERS, skaters, 'NHL_SKATER');
  if (goalies.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.NHL_GOALIES, goalies, 'NHL_GOALIE');

  console.log(`[player-rankings] NHL done: ${skaters.length} skaters, ${goalies.length} goalies`);
  return all.length;
}

async function updateNBARankings(injuryMap) {
  console.log('[player-rankings] === NBA ===');
  const roster = await readRoster('NBA');
  if (roster.length === 0) return 0;

  const playersWithStats = await fetchAllPlayerStats(roster, 'NBA');
  for (const p of playersWithStats) p.posGroup = 'NBA';

  if (playersWithStats.length > 0) computeCompositeScores(playersWithStats, 'NBA');

  await writeSummarySheet(PR_CONFIG.rankingSheets.NBA_SUMMARY, playersWithStats, injuryMap);
  if (playersWithStats.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.NBA_STATS, playersWithStats, 'NBA');

  console.log(`[player-rankings] NBA done: ${playersWithStats.length} players`);
  return playersWithStats.length;
}

async function updateNFLRankings(injuryMap) {
  console.log('[player-rankings] === NFL ===');
  const roster = await readRoster('NFL');
  if (roster.length === 0) return 0;

  const playersWithStats = await fetchAllPlayerStats(roster, 'NFL');
  const qbs = [], skill = [], def = [];

  for (const p of playersWithStats) {
    const group = PR_CONFIG.positionGroups.NFL[p.pos] || 'NFL_SKILL';
    p.posGroup = group;
    if (group === 'NFL_QB') qbs.push(p);
    else if (group === 'NFL_DEF') def.push(p);
    else skill.push(p);
  }

  if (qbs.length > 0) computeCompositeScores(qbs, 'NFL_QB');
  if (skill.length > 0) computeCompositeScores(skill, 'NFL_SKILL');
  if (def.length > 0) computeCompositeScores(def, 'NFL_DEF');

  const all = [...qbs, ...skill, ...def];
  await writeSummarySheet(PR_CONFIG.rankingSheets.NFL_SUMMARY, all, injuryMap);
  if (qbs.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.NFL_QB, qbs, 'NFL_QB');
  if (skill.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.NFL_SKILL, skill, 'NFL_SKILL');
  if (def.length > 0) await writeDetailSheet(PR_CONFIG.rankingSheets.NFL_DEF, def, 'NFL_DEF');

  console.log(`[player-rankings] NFL done: ${qbs.length} QBs, ${skill.length} skill, ${def.length} def`);
  return all.length;
}

// ── Master Function ───────────────────────────────────────────

async function updateAllPlayerRankings() {
  if (!RANKINGS_SPREADSHEET_ID) {
    console.error('[player-rankings] RANKINGS_SPREADSHEET_ID not set — aborting');
    return;
  }

  console.log('[player-rankings] ========== Starting full rankings update ==========');
  const startTime = Date.now();

  const injuryMap = await loadInjuryData();
  const counts = {};

  // NBA first — largest roster, most likely to hit rate limits if run late
  try { counts.NBA = await updateNBARankings(injuryMap); } catch (e) {
    console.error('[player-rankings] NBA failed:', e.message); counts.NBA = 0;
  }
  try { counts.MLB = await updateMLBRankings(injuryMap); } catch (e) {
    console.error('[player-rankings] MLB failed:', e.message); counts.MLB = 0;
  }
  try { counts.NHL = await updateNHLRankings(injuryMap); } catch (e) {
    console.error('[player-rankings] NHL failed:', e.message); counts.NHL = 0;
  }
  try { counts.NFL = await updateNFLRankings(injuryMap); } catch (e) {
    console.error('[player-rankings] NFL failed:', e.message); counts.NFL = 0;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  console.log(`[player-rankings] ========== Done: ${total} players ranked in ${elapsed}s ==========`);
  console.log(`[player-rankings] MLB:${counts.MLB} NHL:${counts.NHL} NBA:${counts.NBA} NFL:${counts.NFL}`);
  return counts;
}

module.exports = {
  updateAllPlayerRankings,
  updateMLBRankings,
  updateNHLRankings,
  updateNBARankings,
  updateNFLRankings,
  PR_CONFIG,
  normalizeZScore,
  computeCompositeScores,
  assignTier,
};
