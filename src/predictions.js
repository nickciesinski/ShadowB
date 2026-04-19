'use strict';
// =============================================================
// src/predictions.js â Core prediction logic
// Replaces: Predictions (Apps Script)
//
// ââ April 2026 rewrite ââ
// GPT-4o removed. All predictions are now deterministic, generated
// by game-model.js using formula-based projections vs market odds.
//
// ââ Sprint 3: Approval Layer ââ
// All picks now pass through approval-engine.js before logging.
// Each pick gets approval_status + approval_reason (cols T, U).
// Approved picks are also written to Daily_Combos sheet.
// =============================================================

const { SPREADSHEET_ID, SHEETS, IS_TEST } = require('./config');
const { getValues, setValues, clearSheet, appendRows } = require('./sheets');
const { parseWeightRows, sheetForLeague } = require('./weights');
const { generateAllPicks } = require('./game-model');
const { americanToImpliedProb } = require('./market-pricing');
const { applyApprovalFilters } = require('./approval-engine');
const db = require('./db');

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââ

function getTargetSheet(baseSheet) {
  return IS_TEST ? SHEETS['TEST_' + baseSheet.replace('Predictions', '')] || baseSheet : baseSheet;
}

/**
 * Convert American odds to implied probability (0-1).
 * Local alias â canonical version lives in market-pricing.js.
 */
function impliedProbability(americanOdds) {
  return americanToImpliedProb(americanOdds);
}

/**
 * Deduplicate raw odds rows into structured game objects with consensus odds.
 * Returns array of { home, away, commence, markets: { h2h, spreads, totals } }
 * Each market has outcomes with median price across bookmakers.
 */
function buildGameObjects(oddsRows, sportFilter) {
  const games = {}; // key: "away@home" -> { home, away, commence, marketsRaw }
  for (const row of oddsRows.slice(1)) {
    if (row[1] !== sportFilter) continue;
    const home = row[2] || '';
    const away = row[3] || '';
    const commence = row[4] || '';
    const market = row[5] || '';
    const outcome = row[6] || '';
    const price = parseFloat(row[7]);
    const point = row[8] || '';
    if (isNaN(price)) continue;

    const gk = `${away}@${home}`;
    if (!games[gk]) games[gk] = { home, away, commence, marketsRaw: {} };
    const mk = `${market}|${outcome}|${point}`;
    if (!games[gk].marketsRaw[mk]) games[gk].marketsRaw[mk] = [];
    games[gk].marketsRaw[mk].push(price);
  }

  // Compute consensus (median) odds per outcome
  return Object.values(games).map(g => {
    const markets = {};
    for (const [mk, prices] of Object.entries(g.marketsRaw)) {
      const [market, outcome, point] = mk.split('|');
      if (!markets[market]) markets[market] = [];
      prices.sort((a, b) => a - b);
      const median = prices[Math.floor(prices.length / 2)];
      markets[market].push({ outcome, price: median, point, impliedProb: impliedProbability(median).toFixed(3) });
    }
    return { home: g.home, away: g.away, commence: g.commence, markets };
  });
}

/**
 * Map confidence (1-10) to unit size. Higher confidence = more units at risk.
 * Every game MUST have a pick on all 3 markets (spread, ML, total).
 * Low confidence picks get minimal units (0.01) rather than being filtered out.
 * Scale: 1-2 â 0.01, 3-4 â 0.05, 5 â 0.1, 6-7 â 0.15, 8 â 0.2, 9 â 0.4, 10 â 0.5
 * (7-8 tier tightened after early data showed 58% wins but -2.2% ROI at old sizing)
 */
function confidenceToUnits(confidence) {
  const c = parseInt(confidence) || 5;
  if (c <= 2) return 0.01;
  if (c <= 4) return 0.05;
  if (c === 5) return 0.1;
  if (c <= 7) return 0.15;
  if (c === 8) return 0.2;
  if (c === 9) return 0.4;
  return 0.5;
}

/**
 * League+market performance modifiers based on historical ROI.
 * Multiplier on units: >1 = boost profitable segments, <1 = reduce losing ones.
 * Updated periodically based on Performance Log analysis.
 */
// Updated 2026-04-08 based on 30-day offline-optimize run.
// NBA|moneyline ROI metric is contaminated by the stake=0 bug; modifier is
// held (not cut further) until grading runs on clean data post-fix.
const PERFORMANCE_MODIFIERS = {
  'NHL|spread':     1.15,  // 30d: 53.2% / +10.6% ROI (n=250) â boost
  'NHL|moneyline':  1.15,  // 30d: 56.4% / +13.5% ROI (n=250) â boost
  'NHL|total':      1.35,  // 30d: 52.8% / +13.0% ROI (n=196) â boost
  'NBA|spread':     1.05,  // 30d: 55.3% / +6.9% ROI (n=204) â slight boost
  'NBA|moneyline':  0.3,   // HOLD â data corrupted by stake=0 bug, re-evaluate after fix
  'NBA|total':      0.7,   // 30d: 45.5% / -11.6% ROI (n=167) â cut hard
  'MLB|spread':     0.7,   // 30d: 44.2% / -17.3% ROI (n=138) â cut hard, biggest bleeder
  'MLB|moneyline':  0.6,   // 30d: 52.2% / -3.6% ROI (n=136) â reduce 15%
  'MLB|total':      0.5,   // 30d: 53.8% / -2.1% ROI (n=92) â hold
  'NFL|spread':     1.0,   // no recent NFL activity
  'NFL|moneyline':  0.8,
  'NFL|total':      0.9,
};

// Cache for Supabase modifiers (loaded once per trigger run)
let _dbModifiers = null;
let _dbModifiersLoaded = false;

async function loadDbModifiers() {
  if (_dbModifiersLoaded) return _dbModifiers;
  _dbModifiersLoaded = true;
  if (!db.isEnabled()) return null;
  try {
    _dbModifiers = await db.readModifiers();
    if (_dbModifiers && Object.keys(_dbModifiers).length > 0) {
      console.log(`[predictions] Loaded ${Object.keys(_dbModifiers).length} modifiers from Supabase`);
    } else {
      _dbModifiers = null;
    }
  } catch (err) {
    console.warn('[predictions] Could not load Supabase modifiers:', err.message);
    _dbModifiers = null;
  }
  return _dbModifiers;
}

function getPerformanceModifier(league, betType) {
  const key = `${league}|${betType.toLowerCase()}`;
  // Prefer Supabase modifiers if loaded, fall back to hardcoded
  if (_dbModifiers && _dbModifiers[key] !== undefined) return _dbModifiers[key];
  return PERFORMANCE_MODIFIERS[key] || 1.0;
}

// No minimum confidence filter â every game gets all 3 market picks.
// Low-confidence picks use minimal units (0.01) instead of being excluded.

// ââ MLB Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate MLB picks using deterministic game model.
 * Trigger 4 (Part 1): 5:00 AM ET daily
 */
async function generateMLBPredictions() {
  console.log('[predictions] Generating MLB predictions (deterministic)...');
  await loadDbModifiers();

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS),
    getValues(SPREADSHEET_ID, SHEETS.TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'MLB');
  console.log(`[predictions] MLB: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No MLB games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  // Deterministic pick generation â no OpenAI
  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'MLB', getPerformanceModifier);
  console.log(`[predictions] MLB: ${picks.length} deterministic picks generated`);

  // Sprint 3: Apply approval filters before logging
  applyApprovalFilters(picks, 'MLB');

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'MLB', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.MLB_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] MLB: ${picks.length} picks written to ${targetSheet}`);

  await logPicksToPerformanceLog(picks, 'MLB', oddsRows, parsedWeights.flat);
  await writeApprovedToDailyCombos(picks, 'MLB');
}

// ââ NBA Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate NBA picks using deterministic game model.
 * Trigger 4 (Part 2)
 */
async function generateNBAPredictions() {
  console.log('[predictions] Generating NBA predictions (deterministic)...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NBA),
    getValues(SPREADSHEET_ID, SHEETS.NBA_TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'NBA');
  console.log(`[predictions] NBA: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NBA games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'NBA', getPerformanceModifier);
  console.log(`[predictions] NBA: ${picks.length} deterministic picks generated`);

  // Sprint 3: Apply approval filters before logging
  applyApprovalFilters(picks, 'NBA');

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'NBA', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.NBA_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] NBA: ${picks.length} picks written to ${targetSheet}`);

  await logPicksToPerformanceLog(picks, 'NBA', oddsRows, parsedWeights.flat);
  await writeApprovedToDailyCombos(picks, 'NBA');
}

// ââ NHL Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate NHL picks using deterministic game model.
 * NHL spread (puckline) has historically been the strongest market.
 */
async function generateNHLPredictions() {
  console.log('[predictions] Generating NHL predictions (deterministic)...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NHL),
    getValues(SPREADSHEET_ID, SHEETS.NHL_TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'NHL');
  console.log(`[predictions] NHL: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NHL games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'NHL', getPerformanceModifier);
  console.log(`[predictions] NHL: ${picks.length} deterministic picks generated`);

  // Sprint 3: Apply approval filters before logging
  applyApprovalFilters(picks, 'NHL');

  await logPicksToPerformanceLog(picks, 'NHL', oddsRows, parsedWeights.flat);
  await writeApprovedToDailyCombos(picks, 'NHL');
  console.log(`[predictions] NHL: ${picks.length} picks logged to Performance Log`);
}

// ââ NFL Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate NFL picks using deterministic game model.
 * Only runs during NFL season (Sep-Feb).
 */
async function generateNFLPredictions() {
  console.log('[predictions] Generating NFL predictions (deterministic)...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NFL),
    getValues(SPREADSHEET_ID, SHEETS.NFL_TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'NFL');
  console.log(`[predictions] NFL: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NFL games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'NFL', getPerformanceModifier);
  console.log(`[predictions] NFL: ${picks.length} deterministic picks generated`);

  // Sprint 3: Apply approval filters before logging
  applyApprovalFilters(picks, 'NFL');

  await logPicksToPerformanceLog(picks, 'NFL', oddsRows, parsedWeights.flat);
  await writeApprovedToDailyCombos(picks, 'NFL');
  console.log(`[predictions] NFL: ${picks.length} picks logged to Performance Log`);
}

// ââ Performance Log Writer âââââââââââââââââââââââââââââââââââââââ

/**
 * Log picks to the Performance Log so they can be graded later.
 * Matches picks to odds data to fill in away/home teams, start time, etc.
 *
 * Performance Log columns:
 *   A: date, B: league, C: market, D: awayTeam, E: homeTeam, F: start_time,
 *   G: bet_type, H: pick, I: line, J: odds, K: units, L: confidence,
 *   M: prediction_score, N: preAwayScore, O: preHomeScore, P: preTotal,
 *   Q: result, R: unit_return, S: weights_snapshot,
 *   T: approval_status, U: approval_reason
 */
async function logPicksToPerformanceLog(picks, sport, oddsRows, weights) {
  if (!picks || picks.length === 0) return;

  // Format date as MM/DD/YYYY string
  const today = new Date();
  const mm = String(today.getMonth() + 1);
  const dd = String(today.getDate());
  const yyyy = today.getFullYear();
  const dateStr = `${mm}/${dd}/${yyyy}`;

  // Build odds lookup by team name for matching â store game info + per-game odds
  // Game Odds columns: 0=Timestamp, 1=Sport, 2=HomeTeam, 3=AwayTeam, 4=CommenceTime,
  //                    5=Market(h2h/spreads/totals), 6=Outcome, 7=Price, 8=Point, 9=BookmakerKey
  const gameLookup = {};   // team -> { away, home, commence, gameKey }
  const oddsMap = {};      // "outcome|market" -> { price, point }
  const gameOddsMap = {};  // "gameKey|outcome|market" -> { price, point }
  for (const row of oddsRows.slice(1)) {
    if (row[1] !== sport) continue;
    const home = row[2] || '';
    const away = row[3] || '';
    const commence = row[4] || '';
    const market = row[5] || '';   // h2h, spreads, totals
    const outcome = row[6] || '';  // team name or Over/Under
    const price = parseFloat(row[7]) || 0;
    const point = row[8] || '';
    const gameKey = `${away}@${home}`;

    // Store game info (keyed by both team names)
    if (!gameLookup[home]) gameLookup[home] = { away, home, commence, gameKey };
    if (!gameLookup[away]) gameLookup[away] = { away, home, commence, gameKey };

    // Store best odds per outcome+market (first bookmaker = consensus)
    const oddsKey = `${outcome}|${market}`;
    if (!oddsMap[oddsKey]) oddsMap[oddsKey] = { price, point };

    // Also store per-game odds (needed for totals which are game-specific)
    const gameOddsKey = `${gameKey}|${outcome}|${market}`;
    if (!gameOddsMap[gameOddsKey]) gameOddsMap[gameOddsKey] = { price, point };
  }

  // PICK COVERAGE RULE: Every game MUST produce a pick on all 3 markets
  // (moneyline, spread, total). Low-confidence picks are NOT dropped â they
  // get the minimum stake via confidenceToUnits() + the param_min_units_to_bet
  // floor enforced below. param_min_confidence_to_bet is intentionally unused
  // as a drop filter. See memory/feedback_pick_coverage_rule.md.

  const perfRows = [];
  for (const p of picks) {
    const team = p.team || '';
    const rawBetType = (p.betType || '').toLowerCase();
    const confidence = p.confidence || '';

    // Sprint 3: approval fields (set by applyApprovalFilters before this call)
    const approvalStatus = p.approval_status || 'tracking_only';
    const approvalReason = p.approval_reason || '';

    // ââ Deterministic pick fast path ââ
    // Picks from game-model.js have _units and _odds pre-calculated.
    // Skip all the GPT normalization logic.
    if (p._units !== undefined && p._units > 0) {
      const isTotal = rawBetType === 'total' || rawBetType === 'over' || rawBetType === 'under';
      const isMoneyline = rawBetType === 'moneyline';
      const betType = isTotal ? 'total' : isMoneyline ? 'moneyline' : rawBetType;

      // Find game info for this pick
      let game = gameLookup[team] || {};
      if (!game.away && isTotal) {
        // Total picks have team name like "Over 8.5" â find game from rationale
        const rationale = (p.rationale || '').toLowerCase();
        for (const [teamName, info] of Object.entries(gameLookup)) {
          if (rationale.includes(teamName.toLowerCase())) { game = info; break; }
        }
        if (!game.away) {
          const first = Object.values(gameLookup)[0];
          if (first) game = first;
        }
      }

      const units = Math.max(0.01, p._units);
      const odds = p._odds || -110;
      const pick = team;
      const line = p.line || '';

      perfRows.push([
        dateStr, sport, betType, game.away || '', game.home || '', game.commence || '',
        betType, pick, line, odds, units, `${confidence}%`, 0, 0, 0, 0, '', '',
        JSON.stringify(weights || {}),
        approvalStatus,    // T: approval_status
        approvalReason,    // U: approval_reason
      ]);
      continue;
    }

    // ââ Legacy GPT pick path (kept for backward compat) ââ
    // Normalize bet type â GPT sometimes returns "over"/"under" instead of "total"
    const isTotal = rawBetType === 'total' || rawBetType === 'totals' || rawBetType === 'over' || rawBetType === 'under';
    const isMoneyline = rawBetType === 'moneyline' || rawBetType === 'h2h';
    const isSpread = rawBetType === 'spread' || rawBetType === 'spreads';
    const betType = isTotal ? 'total' : isMoneyline ? 'moneyline' : isSpread ? 'spread' : rawBetType;

    // Confidence-scaled units with league/market performance modifier
    const baseUnits = confidenceToUnits(confidence);
    const modifier = getPerformanceModifier(sport, betType);
    let units = parseFloat((baseUnits * modifier).toFixed(3));

    // Enforce minimum stake.
    const minUnits = (weights && Number.isFinite(weights.param_min_units_to_bet))
      ? weights.param_min_units_to_bet
      : 0.01;
    if (!Number.isFinite(units) || units < minUnits) {
      units = minUnits;
    }

    // Try to find the game in odds data
    let game = gameLookup[team] || {};
    if (!game.away && isTotal) {
      const rationale = (p.rationale || '').toLowerCase();
      for (const [teamName, info] of Object.entries(gameLookup)) {
        if (rationale.includes(teamName.toLowerCase())) {
          game = info;
          break;
        }
      }
      if (!game.away) {
        const firstGame = Object.values(gameLookup)[0];
        if (firstGame) game = firstGame;
      }
    }
    const awayTeam = game.away || '';
    const homeTeam = game.home || '';
    const startTime = game.commence || '';
    const gameKey = game.gameKey || '';

    let odds = -110;
    let line = '';
    let pick = team;

    if (isMoneyline) {
      // Moneyline: odds from h2h market, no line
      const entry = oddsMap[`${team}|h2h`] || {};
      odds = entry.price || -110;
      line = '';  // moneyline has no line/point
      pick = team;

    } else if (isSpread) {
      // Spread: odds and point from spreads market
      const entry = oddsMap[`${team}|spreads`] || {};
      odds = entry.price || -110;
      line = entry.point || p.line || '';
      pick = team;

    } else if (isTotal) {
      // Total: determine Over/Under direction from GPT output
      const gptLine = String(p.line || '').toLowerCase();
      const gptRationale = String(p.rationale || '').toLowerCase();
      const isOver = rawBetType === 'over' || gptLine.includes('over') || gptRationale.includes('over');
      const direction = isOver ? 'Over' : 'Under';

      // Look up totals for this specific game first, then fall back to global
      let entry;
      if (gameKey) {
        entry = isOver
          ? gameOddsMap[`${gameKey}|Over|totals`]
          : gameOddsMap[`${gameKey}|Under|totals`];
      }
      if (!entry) {
        entry = isOver
          ? oddsMap['Over|totals']
          : oddsMap['Under|totals'];
      }
      entry = entry || {};
      odds = entry.price || -110;
      line = parseFloat(entry.point) || parseFloat(String(p.line).replace(/[^0-9.]/g, '')) || '';
      pick = line ? `${direction} ${line}` : direction;
    }

    // Heavy favorite cap: moneyline bets on favorites past -200 get capped to 0.01 units.
    // These win often but one upset wipes out 3-4 wins worth of profit (NBA ML: 71% win, -9.5% ROI).
    if (isMoneyline && odds < -200) {
      console.log(`[predictions] Heavy fav cap: ${pick} ML ${odds} â units capped to 0.01 (was ${units})`);
      units = 0.01;
    }

    // Absolute floor: no bet should ever have 0 units. If any calculation path
    // (modifier, rounding, heavy-fav cap, etc.) produces 0, force to 0.01.
    if (!Number.isFinite(units) || units <= 0) {
      units = 0.01;
    }

    console.log(`[predictions] Perf row: date=${dateStr} sport=${sport} betType=${betType} pick=${pick} odds=${odds} line=${line} units=${units} away=${awayTeam} home=${homeTeam} approval=${approvalStatus}`);

    perfRows.push([
      dateStr,          // A: date
      sport,            // B: league
      betType,          // C: market (normalized)
      awayTeam,         // D: Away Team
      homeTeam,         // E: Home Team
      startTime,        // F: start_time
      betType,          // G: bet_type (normalized)
      pick,             // H: pick
      line,             // I: line
      odds,             // J: odds
      units,            // K: units
      `${confidence}%`, // L: confidence
      0,                // M: prediction_score
      0,                // N: Pre Away Score
      0,                // O: Pre Home Score
      0,                // P: Pre Total
      '',               // Q: result (empty â to be graded)
      '',               // R: unit_return (empty â to be graded)
      JSON.stringify(weights || {}), // S: weights_snapshot
      approvalStatus,   // T: approval_status
      approvalReason,   // U: approval_reason
    ]);
  }

  // COVERAGE BACKFILL: For every game in the odds data, ensure we have ML +
  // spread + total picks. If GPT skipped a market (common for totals), synthesize
  // a minimum-stake pick so every game is fully represented. Low confidence
  // picks are intentionally NOT dropped â see feedback_pick_coverage_rule.
  const minUnits = (weights && Number.isFinite(weights.param_min_units_to_bet))
    ? weights.param_min_units_to_bet
    : 0.01;
  const seenByGame = {}; // gameKey -> Set of betTypes
  for (const r of perfRows) {
    const gk = `${r[3]}@${r[4]}`;
    if (!seenByGame[gk]) seenByGame[gk] = new Set();
    seenByGame[gk].add(r[6]);
  }
  const seenGameKeys = new Set();
  const uniqueGames = [];
  for (const info of Object.values(gameLookup)) {
    if (!info || !info.gameKey || seenGameKeys.has(info.gameKey)) continue;
    seenGameKeys.add(info.gameKey);
    uniqueGames.push(info);
  }
  let backfilled = 0;
  for (const info of uniqueGames) {
    const gk = info.gameKey;
    const have = seenByGame[gk] || new Set();

    // ââ Moneyline backfill: pick favorite (lowest price â highest implied prob)
    if (!have.has('moneyline')) {
      const homeEntry = oddsMap[`${info.home}|h2h`] || gameOddsMap[`${gk}|${info.home}|h2h`];
      const awayEntry = oddsMap[`${info.away}|h2h`] || gameOddsMap[`${gk}|${info.away}|h2h`];
      let pickTeam = '', pickOdds = -110;
      if (homeEntry && awayEntry && homeEntry.price && awayEntry.price) {
        if (homeEntry.price <= awayEntry.price) {
          pickTeam = info.home; pickOdds = homeEntry.price;
        } else {
          pickTeam = info.away; pickOdds = awayEntry.price;
        }
      } else if (homeEntry && homeEntry.price) {
        pickTeam = info.home; pickOdds = homeEntry.price;
      } else if (awayEntry && awayEntry.price) {
        pickTeam = info.away; pickOdds = awayEntry.price;
      }
      if (pickTeam) {
        let units = Math.max(minUnits, 0.01);
        if (pickOdds < -200) units = 0.01; // heavy-fav cap
        perfRows.push([
          dateStr, sport, 'moneyline', info.away, info.home, info.commence,
          'moneyline', pickTeam, '', pickOdds, units, '1%', 0, 0, 0, 0, '', '',
          JSON.stringify(weights || {}),
          'tracking_only',                // T: backfill picks are always tracking
          'backfill pick (confidence â¤1%)', // U: approval_reason
        ]);
        backfilled++;
      }
    }

    // ââ Spread backfill: pick home team at their listed spread
    if (!have.has('spread')) {
      let entry = oddsMap[`${info.home}|spreads`] || gameOddsMap[`${gk}|${info.home}|spreads`];
      // Fallback: if no spreads odds (common for NHL), use sport default puckline/spread at -110
      const DEFAULT_SPREADS = { NHL: -1.5, NBA: -1.5, MLB: -1.5, NFL: -2.5 };
      if (!entry || !entry.price) {
        const defaultSpread = DEFAULT_SPREADS[sport];
        if (defaultSpread) entry = { price: -110, point: defaultSpread };
      }
      if (entry && entry.price) {
        const spreadUnits = Math.max(minUnits, 0.01);
        perfRows.push([
          dateStr, sport, 'spread', info.away, info.home, info.commence,
          'spread', info.home, entry.point || '', entry.price, spreadUnits, '1%', 0, 0, 0, 0, '', '',
          JSON.stringify(weights || {}),
          'tracking_only',                // T: backfill picks are always tracking
          'backfill pick (confidence â¤1%)', // U: approval_reason
        ]);
        backfilled++;
      }
    }

    // ââ Total backfill: prefer Over at per-game listed total
    // If no totals odds exist (common for NHL where API only returns h2h),
    // fall back to sport-specific default total lines.
    if (!have.has('total')) {
      let entry = gameOddsMap[`${gk}|Over|totals`] || oddsMap['Over|totals'];
      let direction = 'Over';
      if (!entry || !entry.price) {
        entry = gameOddsMap[`${gk}|Under|totals`] || oddsMap['Under|totals'];
        direction = 'Under';
      }
      // Fallback: if no totals odds at all, use sport default line at -110
      const DEFAULT_TOTALS = { NHL: 6, NBA: 220, MLB: 8.5, NFL: 44.5 };
      if (!entry || !entry.price) {
        const defaultLine = DEFAULT_TOTALS[sport];
        if (defaultLine) {
          entry = { price: -110, point: defaultLine };
          direction = 'Over';
        }
      }
      if (entry && entry.price) {
        const lineNum = parseFloat(entry.point) || '';
        const pick = lineNum ? `${direction} ${lineNum}` : direction;
        const totalUnits = Math.max(minUnits, 0.01);
        perfRows.push([
          dateStr, sport, 'total', info.away, info.home, info.commence,
          'total', pick, lineNum, entry.price, totalUnits, '1%', 0, 0, 0, 0, '', '',
          JSON.stringify(weights || {}),
          'tracking_only',                // T: backfill picks are always tracking
          'backfill pick (confidence â¤1%)', // U: approval_reason
        ]);
        backfilled++;
      }
    }
  }
  if (backfilled > 0) {
    console.log(`[predictions] ${sport}: coverage backfill added ${backfilled} minimum-stake picks across ${uniqueGames.length} games`);
  }

  // Dedup ALL markets: per game+market, keep the pick with highest confidence.
  // This catches duplicate totals (Over/Under on same game) AND duplicate
  // moneyline/spread picks (e.g. from trigger4+trigger5 overlap or GPT returning
  // the same game twice).
  const seenPicks = {};  // "gameKey|betType" -> index in perfRows
  const toRemove = new Set();
  for (let i = 0; i < perfRows.length; i++) {
    const row = perfRows[i];
    const betType = row[6]; // G: bet_type
    const gameKey = `${row[3]}@${row[4]}`; // D: away @ E: home
    const dedupKey = `${gameKey}|${betType}`;
    const conf = parseFloat(String(row[11]).replace('%', '')) || 0; // L: confidence
    const units = parseFloat(row[10]) || 0; // K: units (tiebreaker)
    if (seenPicks[dedupKey] !== undefined) {
      const prevIdx = seenPicks[dedupKey];
      const prevConf = parseFloat(String(perfRows[prevIdx][11]).replace('%', '')) || 0;
      const prevUnits = parseFloat(perfRows[prevIdx][10]) || 0;
      // Keep higher confidence; if tied, keep higher units (GPT-generated over backfill)
      if (conf > prevConf || (conf === prevConf && units > prevUnits)) {
        toRemove.add(prevIdx);
        seenPicks[dedupKey] = i;
        console.log(`[predictions] Dedup: removed duplicate ${betType} for ${gameKey} (kept conf ${conf}% over ${prevConf}%)`);
      } else {
        toRemove.add(i);
        console.log(`[predictions] Dedup: removed duplicate ${betType} for ${gameKey} (kept conf ${prevConf}% over ${conf}%)`);
      }
    } else {
      seenPicks[dedupKey] = i;
    }
  }
  const dedupedPerfRows = perfRows.filter((_, i) => !toRemove.has(i));

  if (dedupedPerfRows.length > 0) {
    // Prepend new picks at the top (after header row) instead of appending at bottom
    const existing = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
    const header = existing.length > 0 ? [existing[0]] : [];
    const oldRows = existing.slice(1);

    // Cross-trigger dedup: skip new rows that already exist in the Performance Log
    // (prevents duplicates if trigger4 and trigger5 both run, or if a trigger retries)
    const existingKeys = new Set();
    for (const row of oldRows) {
      const eDate = String(row[0] || '').slice(0, 10);
      const eSport = row[1] || '';
      const eAway = row[3] || '';
      const eHome = row[4] || '';
      const eBetType = row[6] || '';
      if (eSport === sport) existingKeys.add(`${eDate}|${eAway}@${eHome}|${eBetType}`);
    }
    const finalRows = dedupedPerfRows.filter(row => {
      const rDate = String(row[0] || '').slice(0, 10);
      const key = `${rDate}|${row[3]}@${row[4]}|${row[6]}`;
      return !existingKeys.has(key);
    });
    const crossDupes = dedupedPerfRows.length - finalRows.length;
    if (crossDupes > 0) {
      console.log(`[predictions] ${sport}: skipped ${crossDupes} picks already in Performance Log`);
    }

    if (finalRows.length > 0) {
      const newData = [...header, ...finalRows, ...oldRows];
      // Clear first to avoid stale row artifacts, then write the full dataset
      await clearSheet(SPREADSHEET_ID, SHEETS.PERFORMANCE);
      await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', newData);
      console.log(`[predictions] Logged ${finalRows.length} ${sport} picks to top of Performance Log (${perfRows.length - finalRows.length} duplicates removed)`);
    } else {
      console.log(`[predictions] ${sport}: all picks already exist in Performance Log, nothing new to write`);
    }

    // Dual-write to Supabase (non-blocking â log errors but don't fail the trigger)
    if (db.isEnabled() && finalRows && finalRows.length > 0) {
      try {
        const dbRows = finalRows.map(r => ({
          date: String(r[0] || '').replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'), // MM/DD/YYYY â YYYY-MM-DD
          league: r[1] || '',
          game: `${r[3]} @ ${r[4]}`,
          market: r[6] || '',
          pick: r[7] || '',
          line: parseFloat(r[8]) || null,
          odds: parseInt(r[9]) || null,
          confidence: parseInt(String(r[11]).replace('%', '')) || null,
          final_units: parseFloat(r[10]) || 0,
          modifier: getPerformanceModifier(r[1], r[6]),
          trigger_name: `trigger4_${sport}`,
          approval_status: r[19] || 'tracking_only',  // Sprint 3
        }));
        await db.insertPerformanceRows(dbRows);
        console.log(`[predictions] Dual-wrote ${dbRows.length} ${sport} picks to Supabase`);
      } catch (err) {
        console.warn(`[predictions] Supabase dual-write failed for ${sport}:`, err.message);
      }
    }
  }
}

// ââ Daily Combos Writer (Sprint 3) ââââââââââââââââââââââââââââââ

/**
 * Write approved picks to the Daily_Combos sheet.
 * Only picks with approval_status === 'approved' are written here.
 * This sheet feeds the daily email's "Recommended Plays" section.
 *
 * Daily_Combos columns:
 *   A: date, B: league, C: market, D: away, E: home,
 *   F: pick, G: line, H: odds, I: units, J: confidence, K: edge
 */
async function writeApprovedToDailyCombos(picks, sport) {
  if (!picks || picks.length === 0) return;

  const approved = picks.filter(p => p.approval_status === 'approved');
  if (approved.length === 0) {
    console.log(`[predictions] ${sport}: no approved picks for Daily_Combos`);
    return;
  }

  const today = new Date();
  const mm = String(today.getMonth() + 1);
  const dd = String(today.getDate());
  const yyyy = today.getFullYear();
  const dateStr = `${mm}/${dd}/${yyyy}`;

  const rows = approved.map(p => [
    dateStr,
    sport,
    (p.betType || '').toLowerCase(),
    '',                            // away â filled at email time from perf log
    '',                            // home â filled at email time from perf log
    p.team || '',
    p.line || '',
    p._odds || -110,
    p._units || 0,
    `${p.confidence || 0}%`,
    p._edge !== undefined ? `${p._edge.toFixed(1)}%` : '',
  ]);

  try {
    await appendRows(SPREADSHEET_ID, SHEETS.DAILY_COMBOS, rows);
    console.log(`[predictions] ${sport}: wrote ${rows.length} approved picks to Daily_Combos`);
  } catch (err) {
    console.warn(`[predictions] ${sport}: Daily_Combos write failed:`, err.message);
  }
}

// ââ CLV Snapshot âââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Take a closing line value snapshot.
 * Trigger 3 (part of fetchOddsAndGrade).
 */
async function takeCLVSnapshot() {
  console.log('[predictions] Taking CLV snapshot...');
  const oddsRows = await getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS);
  const ts = new Date().toISOString();
  const snapshotRows = oddsRows.slice(1).map(r => [ts, ...r]);
  if (snapshotRows.length > 0) {
    await appendRows(SPREADSHEET_ID, SHEETS.CLV_SNAPSHOT, snapshotRows);
    console.log(`[predictions] CLV snapshot: ${snapshotRows.length} rows`);
  }
}

// ââ Post-Game Grading ââââââââââââââââââââââââââââââââââââââââ

/**
 * Calculate the unit return for a graded bet.
 * @param {'W'|'L'|'P'} result
 * @param {number} units - units wagered
 * @param {number} odds - American odds (e.g. -110, +150)
 * @param {string} market - 'moneyline', 'spread', or 'total'
 */
function calculateUnitReturn(result, units, odds, market) {
  if (result === 'P') return 0;
  if (result === 'L') return -units;
  // Win
  if (market.toLowerCase() === 'moneyline') {
    // Moneyline uses actual odds for payout
    return odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
  }
  // Spread and total default to standard -110 juice (0.91 return)
  const effectiveOdds = odds || -110;
  return effectiveOdds > 0 ? units * (effectiveOdds / 100) : units * (100 / Math.abs(effectiveOdds));
}

/**
 * Determine bet result (W/L/P) based on market type and scores.
 * @param {string} market - 'moneyline', 'spread', or 'total'
 * @param {string} pick - team name or 'Over'/'Under'
 * @param {number} line - spread or total line
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {number} homeScore
 * @param {number} awayScore
 */
function determineBetResult(market, pick, line, homeTeam, awayTeam, homeScore, awayScore) {
  const mkt = market.toLowerCase();

  if (mkt === 'moneyline') {
    const pickTeam = pick.trim();
    if (homeScore === awayScore) return 'P';
    if (awayScore > homeScore && pickTeam === awayTeam) return 'W';
    if (homeScore > awayScore && pickTeam === homeTeam) return 'W';
    return 'L';
  }

  if (mkt === 'spread') {
    const lineNum = parseFloat(line) || 0;
    // Determine which team was picked
    const pickTeam = pick.includes(awayTeam) ? awayTeam : homeTeam;
    let adjustedAway = awayScore;
    let adjustedHome = homeScore;
    if (pickTeam === awayTeam) {
      adjustedAway += lineNum;
    } else {
      adjustedHome += lineNum;
    }
    if (adjustedAway === adjustedHome) return 'P';
    if (pickTeam === awayTeam && adjustedAway > adjustedHome) return 'W';
    if (pickTeam === homeTeam && adjustedHome > adjustedAway) return 'W';
    return 'L';
  }

  if (mkt === 'total') {
    const totalLine = parseFloat(line) || 0;
    const actualTotal = homeScore + awayScore;
    const pickType = pick.toLowerCase();
    if (actualTotal === totalLine) return 'P';
    if (pickType.includes('over') && actualTotal > totalLine) return 'W';
    if (pickType.includes('under') && actualTotal < totalLine) return 'W';
    return 'L';
  }

  return ''; // Unknown market
}

/**
 * Build a lookup map from the Closing_Odds_Snapshot sheet.
 * Each row in the snapshot is [snapshot_ts, ...originalOddsRow], where the
 * original odds row is: [ts, sport, home, away, commence, market, outcome, price, point, bookmaker]
 * We pick the most recent snapshot per (sport|away|home|market|outcome) combo.
 */
function buildClosingOddsMap(snapshotRows) {
  const map = {};
  if (!snapshotRows || snapshotRows.length < 2) return map;
  for (const row of snapshotRows.slice(1)) {
    // row[0] = snapshot_ts (added by takeCLVSnapshot)
    const sport = row[2] || '';
    const home = row[3] || '';
    const away = row[4] || '';
    const mktRaw = row[6] || '';
    const outcome = row[7] || '';
    const price = parseFloat(row[8]);
    const point = row[9] || '';
    if (!isFinite(price)) continue;
    // Normalize market label from Odds API -> internal
    const market = mktRaw === 'h2h' ? 'moneyline'
                 : mktRaw === 'spreads' ? 'spread'
                 : mktRaw === 'totals' ? 'total' : mktRaw;
    const key = `${sport}|${away}|${home}|${market}|${outcome}`;
    // Keep the latest snapshot (closest to game time = closing line)
    const existing = map[key];
    if (!existing || String(row[0]) > String(existing.ts)) {
      map[key] = { ts: row[0], price, point };
    }
  }
  return map;
}

/**
 * Look up the closing line for a graded bet and compute a CLV grade.
 * Grades:
 *   'good' = we beat the close (our price was better than the closing price)
 *   'flat' = within 5 cents
 *   'bad'  = we took worse-than-closing odds
 */
function lookupClosingOdds(closingMap, league, away, home, market, pick, line) {
  if (!closingMap) return null;
  const mkt = String(market || '').toLowerCase();
  let outcome;
  if (mkt === 'moneyline' || mkt === 'spread') {
    // outcome is the team name we picked
    outcome = pick.includes(away) ? away : home;
  } else if (mkt === 'total') {
    // "Over 8.5" -> "Over"
    outcome = String(pick).trim().split(/\s+/)[0];
  } else {
    return null;
  }
  const key = `${league}|${away}|${home}|${mkt}|${outcome}`;
  const close = closingMap[key];
  if (!close) return null;

  // Compute CLV grade by comparing implied probabilities
  // (higher implied probability = worse price for the bettor)
  // We need the original odds for this bet, which the caller has but we don't here.
  // So we just return the closing price/point and let the caller decide; we compute
  // a simple text grade based on price movement sign when possible.
  const closeLine = mkt === 'total' || mkt === 'spread' ? (close.point || '') : '';
  return {
    closeLine,
    closeOdds: close.price,
    grade: '', // populated post-hoc by compareClv when the caller supplies open odds
  };
}

/**
 * Given the open price we took and the closing price, return a CLV grade.
 * Positive = we beat the close (took better-than-closing odds).
 */
function gradeClvNumeric(openOdds, closeOdds) {
  if (!isFinite(openOdds) || !isFinite(closeOdds)) return '';
  const openImp = openOdds > 0 ? 100 / (openOdds + 100) : Math.abs(openOdds) / (Math.abs(openOdds) + 100);
  const closeImp = closeOdds > 0 ? 100 / (closeOdds + 100) : Math.abs(closeOdds) / (Math.abs(closeOdds) + 100);
  // If the closing price has a HIGHER implied probability than the open we took,
  // the market moved toward our side -> we beat the close -> 'good'.
  const delta = closeImp - openImp;
  if (delta > 0.01) return 'good';
  if (delta < -0.01) return 'bad';
  return 'flat';
}

/**
 * Grade ungraded bets in the Performance Log using Yesterday_Results.
 * Matches ANY ungraded bet (not just yesterday's) against available results
 * by league + away team + home team. This handles backfills and missed days.
 * Trigger 12: 11:00 PM ET daily (post-game).
 *
 * Performance Log columns (0-indexed):
 *   0: date, 1: league, 2: market, 3: awayTeam, 4: homeTeam,
 *   7: pick, 8: line, 9: odds, 10: units, 16: result (W/L/P), 17: unit_return,
 *   19: approval_status, 20: approval_reason
 */
async function gradePerformanceLog() {
  console.log('[predictions] Grading performance log from yesterday results...');

  // Read yesterday's results + closing-odds snapshot in parallel
  const [resultsRows, closingSnapRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS),
    getValues(SPREADSHEET_ID, SHEETS.CLV_SNAPSHOT).catch(() => []),
  ]);
  const closingMap = buildClosingOddsMap(closingSnapRows);
  console.log(`[predictions] CLV snapshot keys loaded: ${Object.keys(closingMap).length}`);
  if (!resultsRows || resultsRows.length < 2) {
    console.log('[predictions] No yesterday results to grade against');
    return { graded: 0 };
  }

  // Build results lookup: key = "LEAGUE|away|home"
  const resultsMap = {};
  for (const row of resultsRows.slice(1)) {
    const league = row[0] || '';
    const away = row[2] || '';
    const home = row[3] || '';
    const key = `${league}|${away}|${home}`;
    resultsMap[key] = {
      awayScore: parseFloat(row[4]) || 0,
      homeScore: parseFloat(row[5]) || 0,
    };
  }
  console.log(`[predictions] Loaded ${Object.keys(resultsMap).length} game results`);

  // Read Performance Log
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) {
    console.log('[predictions] Performance Log is empty');
    return { graded: 0 };
  }

  let graded = 0;
  const maxRows = Math.min(500, perfRows.length);

  for (let i = 1; i < maxRows; i++) {
    const row = perfRows[i];
    if (!row || row.length < 11) continue;

    // Skip if already graded (column Q / index 16)
    const existingResult = (row[16] || '').toString().trim();
    if (existingResult === 'W' || existingResult === 'L' || existingResult === 'P') continue;

    const league = row[1] || '';
    const market = row[2] || '';
    const awayTeam = row[3] || '';
    const homeTeam = row[4] || '';
    const pick = row[7] || '';
    const line = row[8];
    const odds = parseFloat(row[9]) || -110;
    // Stake: accept legitimate zeros, skip garbage/NaN. Do NOT fall back to 1 â
    // that turned a stake-0 bug into phantom -1.00 losses in historical data.
    const unitsRaw = parseFloat(row[10]);
    const units = Number.isFinite(unitsRaw) ? unitsRaw : 0;

    if (!league || !awayTeam || !homeTeam || !pick) continue;

    // Find matching result
    const key = `${league}|${awayTeam}|${homeTeam}`;
    const result = resultsMap[key];
    if (!result) continue;

    // Grade the bet
    const betResult = determineBetResult(market, pick, line, homeTeam, awayTeam, result.homeScore, result.awayScore);
    if (!betResult) continue;

    const unitReturn = calculateUnitReturn(betResult, units, odds, market);

    // CLV lookup: match this bet to the closing-odds snapshot.
    // Key format mirrors the snapshot row layout from takeCLVSnapshot.
    const clvInfo = lookupClosingOdds(closingMap, league, awayTeam, homeTeam, market, pick, line);

    // Write result + unit return back to the row
    // Column Q = index 16, Column R = index 17
    // Columns AE = 30 (close_line), AF = 31 (close_odds), AG = 32 (clv_grade)
    // Column 28 = Pulled Date, 29 = (blank). CLV triplet lives at 30/31/32.
    while (perfRows[i].length < 33) perfRows[i].push('');
    perfRows[i][16] = betResult;
    perfRows[i][17] = parseFloat(unitReturn.toFixed(2));
    if (clvInfo) {
      perfRows[i][30] = clvInfo.closeLine;
      perfRows[i][31] = clvInfo.closeOdds;
      perfRows[i][32] = gradeClvNumeric(odds, clvInfo.closeOdds);
    }

    graded++;
    console.log(`[predictions] Row ${i + 1}: ${betResult} â ${awayTeam} @ ${homeTeam} (${market}) â ${unitReturn.toFixed(2)} units`);
  }

  if (graded > 0) {
    // Write back the full Performance Log with grades applied
    await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', perfRows);
    console.log(`[predictions] Grading complete: ${graded} bets graded`);
  } else {
    console.log('[predictions] No bets matched yesterday\'s results');
  }

  return { graded };
}

module.exports = {
  generateMLBPredictions,
  generateNBAPredictions,
  generateNHLPredictions,
  generateNFLPredictions,
  takeCLVSnapshot,
  gradePerformanceLog,
  writeApprovedToDailyCombos,
  // exported for tests / offline tools
  buildClosingOddsMap,
  lookupClosingOdds,
  gradeClvNumeric,
  calculateUnitReturn,
  determineBetResult,
};
'use strict';
// =============================================================
// src/predictions.js â Core prediction logic
// Replaces: Predictions (Apps Script)
//
// ââ April 2026 rewrite ââ
// GPT-4o removed. All predictions are now deterministic, generated
// by game-model.js using formula-based projections vs market odds.
// =============================================================

const { SPREADSHEET_ID, SHEETS, IS_TEST } = require('./config');
const { getValues, setValues, clearSheet, appendRows } = require('./sheets');
const { parseWeightRows, sheetForLeague } = require('./weights');
const { generateAllPicks } = require('./game-model');
const { americanToImpliedProb } = require('./market-pricing');
const db = require('./db');

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââ

function getTargetSheet(baseSheet) {
  return IS_TEST ? SHEETS['TEST_' + baseSheet.replace('Predictions', '')] || baseSheet : baseSheet;
}

/**
 * Convert American odds to implied probability (0-1).
 * Local alias â canonical version lives in market-pricing.js.
 */
function impliedProbability(americanOdds) {
  return americanToImpliedProb(americanOdds);
}

/**
 * Deduplicate raw odds rows into structured game objects with consensus odds.
 * Returns array of { home, away, commence, markets: { h2h, spreads, totals } }
 * Each market has outcomes with median price across bookmakers.
 */
function buildGameObjects(oddsRows, sportFilter) {
  const games = {}; // key: "away@home" -> { home, away, commence, marketsRaw }
  for (const row of oddsRows.slice(1)) {
    if (row[1] !== sportFilter) continue;
    const home = row[2] || '';
    const away = row[3] || '';
    const commence = row[4] || '';
    const market = row[5] || '';
    const outcome = row[6] || '';
    const price = parseFloat(row[7]);
    const point = row[8] || '';
    if (isNaN(price)) continue;

    const gk = `${away}@${home}`;
    if (!games[gk]) games[gk] = { home, away, commence, marketsRaw: {} };
    const mk = `${market}|${outcome}|${point}`;
    if (!games[gk].marketsRaw[mk]) games[gk].marketsRaw[mk] = [];
    games[gk].marketsRaw[mk].push(price);
  }

  // Compute consensus (median) odds per outcome
  return Object.values(games).map(g => {
    const markets = {};
    for (const [mk, prices] of Object.entries(g.marketsRaw)) {
      const [market, outcome, point] = mk.split('|');
      if (!markets[market]) markets[market] = [];
      prices.sort((a, b) => a - b);
      const median = prices[Math.floor(prices.length / 2)];
      markets[market].push({ outcome, price: median, point, impliedProb: impliedProbability(median).toFixed(3) });
    }
    return { home: g.home, away: g.away, commence: g.commence, markets };
  });
}

/**
 * Map confidence (1-10) to unit size. Higher confidence = more units at risk.
 * Every game MUST have a pick on all 3 markets (spread, ML, total).
 * Low confidence picks get minimal units (0.01) rather than being filtered out.
 * Scale: 1-2 â 0.01, 3-4 â 0.05, 5 â 0.1, 6-7 â 0.15, 8 â 0.2, 9 â 0.4, 10 â 0.5
 * (7-8 tier tightened after early data showed 58% wins but -2.2% ROI at old sizing)
 */
function confidenceToUnits(confidence) {
  const c = parseInt(confidence) || 5;
  if (c <= 2) return 0.01;
  if (c <= 4) return 0.05;
  if (c === 5) return 0.1;
  if (c <= 7) return 0.15;
  if (c === 8) return 0.2;
  if (c === 9) return 0.4;
  return 0.5;
}

/**
 * League+market performance modifiers based on historical ROI.
 * Multiplier on units: >1 = boost profitable segments, <1 = reduce losing ones.
 * Updated periodically based on Performance Log analysis.
 */
// Updated 2026-04-08 based on 30-day offline-optimize run.
// NBA|moneyline ROI metric is contaminated by the stake=0 bug; modifier is
// held (not cut further) until grading runs on clean data post-fix.
const PERFORMANCE_MODIFIERS = {
  'NHL|spread':     1.15,  // 30d: 53.2% / +10.6% ROI (n=250) â boost
  'NHL|moneyline':  1.15,  // 30d: 56.4% / +13.5% ROI (n=250) â boost
  'NHL|total':      1.35,  // 30d: 52.8% / +13.0% ROI (n=196) â boost
  'NBA|spread':     1.05,  // 30d: 55.3% / +6.9% ROI (n=204) â slight boost
  'NBA|moneyline':  0.3,   // HOLD â data corrupted by stake=0 bug, re-evaluate after fix
  'NBA|total':      0.7,   // 30d: 45.5% / -11.6% ROI (n=167) â cut hard
  'MLB|spread':     0.7,   // 30d: 44.2% / -17.3% ROI (n=138) â cut hard, biggest bleeder
  'MLB|moneyline':  0.6,   // 30d: 52.2% / -3.6% ROI (n=136) â reduce 15%
  'MLB|total':      0.5,   // 30d: 53.8% / -2.1% ROI (n=92) â hold
  'NFL|spread':     1.0,   // no recent NFL activity
  'NFL|moneyline':  0.8,
  'NFL|total':      0.9,
};

// Cache for Supabase modifiers (loaded once per trigger run)
let _dbModifiers = null;
let _dbModifiersLoaded = false;

async function loadDbModifiers() {
  if (_dbModifiersLoaded) return _dbModifiers;
  _dbModifiersLoaded = true;
  if (!db.isEnabled()) return null;
  try {
    _dbModifiers = await db.readModifiers();
    if (_dbModifiers && Object.keys(_dbModifiers).length > 0) {
      console.log(`[predictions] Loaded ${Object.keys(_dbModifiers).length} modifiers from Supabase`);
    } else {
      _dbModifiers = null;
    }
  } catch (err) {
    console.warn('[predictions] Could not load Supabase modifiers:', err.message);
    _dbModifiers = null;
  }
  return _dbModifiers;
}

function getPerformanceModifier(league, betType) {
  const key = `${league}|${betType.toLowerCase()}`;
  // Prefer Supabase modifiers if loaded, fall back to hardcoded
  if (_dbModifiers && _dbModifiers[key] !== undefined) return _dbModifiers[key];
  return PERFORMANCE_MODIFIERS[key] || 1.0;
}

// No minimum confidence filter â every game gets all 3 market picks.
// Low-confidence picks use minimal units (0.01) instead of being excluded.

// ââ MLB Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate MLB picks using deterministic game model.
 * Trigger 4 (Part 1): 5:00 AM ET daily
 */
async function generateMLBPredictions() {
  console.log('[predictions] Generating MLB predictions (deterministic)...');
  await loadDbModifiers();

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS),
    getValues(SPREADSHEET_ID, SHEETS.TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'MLB');
  console.log(`[predictions] MLB: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No MLB games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  // Deterministic pick generation â no OpenAI
  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'MLB', getPerformanceModifier);
  console.log(`[predictions] MLB: ${picks.length} deterministic picks generated`);

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'MLB', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.MLB_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] MLB: ${picks.length} picks written to ${targetSheet}`);

  await logPicksToPerformanceLog(picks, 'MLB', oddsRows, parsedWeights.flat);
}

// ââ NBA Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate NBA picks using deterministic game model.
 * Trigger 4 (Part 2)
 */
async function generateNBAPredictions() {
  console.log('[predictions] Generating NBA predictions (deterministic)...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NBA),
    getValues(SPREADSHEET_ID, SHEETS.NBA_TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'NBA');
  console.log(`[predictions] NBA: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NBA games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'NBA', getPerformanceModifier);
  console.log(`[predictions] NBA: ${picks.length} deterministic picks generated`);

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'NBA', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.NBA_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] NBA: ${picks.length} picks written to ${targetSheet}`);

  await logPicksToPerformanceLog(picks, 'NBA', oddsRows, parsedWeights.flat);
}

// ââ NHL Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate NHL picks using deterministic game model.
 * NHL spread (puckline) has historically been the strongest market.
 */
async function generateNHLPredictions() {
  console.log('[predictions] Generating NHL predictions (deterministic)...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NHL),
    getValues(SPREADSHEET_ID, SHEETS.NHL_TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'NHL');
  console.log(`[predictions] NHL: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NHL games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'NHL', getPerformanceModifier);
  console.log(`[predictions] NHL: ${picks.length} deterministic picks generated`);

  await logPicksToPerformanceLog(picks, 'NHL', oddsRows, parsedWeights.flat);
  console.log(`[predictions] NHL: ${picks.length} picks logged to Performance Log`);
}

// ââ NFL Predictions âââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Generate NFL picks using deterministic game model.
 * Only runs during NFL season (Sep-Feb).
 */
async function generateNFLPredictions() {
  console.log('[predictions] Generating NFL predictions (deterministic)...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NFL),
    getValues(SPREADSHEET_ID, SHEETS.NFL_TEAM_STATS),
  ]);

  const games = buildGameObjects(oddsRows, 'NFL');
  console.log(`[predictions] NFL: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NFL games, skipping.');
    return;
  }

  const parsedWeights = parseWeightRows(weightRows);

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const picks = generateAllPicks(games, teamsMap, parsedWeights, 'NFL', getPerformanceModifier);
  console.log(`[predictions] NFL: ${picks.length} deterministic picks generated`);

  await logPicksToPerformanceLog(picks, 'NFL', oddsRows, parsedWeights.flat);
  console.log(`[predictions] NFL: ${picks.length} picks logged to Performance Log`);
}

// ââ Performance Log Writer âââââââââââââââââââââââââââââââââââââââ

/**
 * Log picks to the Performance Log so they can be graded later.
 * Matches picks to odds data to fill in away/home teams, start time, etc.
 *
 * Performance Log columns:
 *   A: date, B: league, C: market, D: awayTeam, E: homeTeam, F: start_time,
 *   G: bet_type, H: pick, I: line, J: odds, K: units, L: confidence,
 *   M: prediction_score, N: preAwayScore, O: preHomeScore, P: preTotal,
 *   Q: result, R: unit_return
 */
async function logPicksToPerformanceLog(picks, sport, oddsRows, weights) {
  if (!picks || picks.length === 0) return;

  // Format date as MM/DD/YYYY string
  const today = new Date();
  const mm = String(today.getMonth() + 1);
  const dd = String(today.getDate());
  const yyyy = today.getFullYear();
  const dateStr = `${mm}/${dd}/${yyyy}`;

  // Build odds lookup by team name for matching â store game info + per-game odds
  // Game Odds columns: 0=Timestamp, 1=Sport, 2=HomeTeam, 3=AwayTeam, 4=CommenceTime,
  //                    5=Market(h2h/spreads/totals), 6=Outcome, 7=Price, 8=Point, 9=BookmakerKey
  const gameLookup = {};   // team -> { away, home, commence, gameKey }
  const oddsMap = {};      // "outcome|market" -> { price, point }
  const gameOddsMap = {};  // "gameKey|outcome|market" -> { price, point }
  for (const row of oddsRows.slice(1)) {
    if (row[1] !== sport) continue;
    const home = row[2] || '';
    const away = row[3] || '';
    const commence = row[4] || '';
    const market = row[5] || '';   // h2h, spreads, totals
    const outcome = row[6] || '';  // team name or Over/Under
    const price = parseFloat(row[7]) || 0;
    const point = row[8] || '';
    const gameKey = `${away}@${home}`;

    // Store game info (keyed by both team names)
    if (!gameLookup[home]) gameLookup[home] = { away, home, commence, gameKey };
    if (!gameLookup[away]) gameLookup[away] = { away, home, commence, gameKey };

    // Store best odds per outcome+market (first bookmaker = consensus)
    const oddsKey = `${outcome}|${market}`;
    if (!oddsMap[oddsKey]) oddsMap[oddsKey] = { price, point };

    // Also store per-game odds (needed for totals which are game-specific)
    const gameOddsKey = `${gameKey}|${outcome}|${market}`;
    if (!gameOddsMap[gameOddsKey]) gameOddsMap[gameOddsKey] = { price, point };
  }

  // PICK COVERAGE RULE: Every game MUST produce a pick on all 3 markets
  // (moneyline, spread, total). Low-confidence picks are NOT dropped â they
  // get the minimum stake via confidenceToUnits() + the param_min_units_to_bet
  // floor enforced below. param_min_confidence_to_bet is intentionally unused
  // as a drop filter. See memory/feedback_pick_coverage_rule.md.

  const perfRows = [];
  for (const p of picks) {
    const team = p.team || '';
    const rawBetType = (p.betType || '').toLowerCase();
    const confidence = p.confidence || '';

    // ââ Deterministic pick fast path ââ
    // Picks from game-model.js have _units and _odds pre-calculated.
    // Skip all the GPT normalization logic.
    if (p._units !== undefined && p._units > 0) {
      const isTotal = rawBetType === 'total' || rawBetType === 'over' || rawBetType === 'under';
      const isMoneyline = rawBetType === 'moneyline';
      const betType = isTotal ? 'total' : isMoneyline ? 'moneyline' : rawBetType;

      // Find game info for this pick
      let game = gameLookup[team] || {};
      if (!game.away && isTotal) {
        // Total picks have team name like "Over 8.5" â find game from rationale
        const rationale = (p.rationale || '').toLowerCase();
        for (const [teamName, info] of Object.entries(gameLookup)) {
          if (rationale.includes(teamName.toLowerCase())) { game = info; break; }
        }
        if (!game.away) {
          const first = Object.values(gameLookup)[0];
          if (first) game = first;
        }
      }

      const units = Math.max(0.01, p._units);
      const odds = p._odds || -110;
      const pick = team;
      const line = p.line || '';

      perfRows.push([
        dateStr, sport, betType, game.away || '', game.home || '', game.commence || '',
        betType, pick, line, odds, units, `${confidence}%`, 0, 0, 0, 0, '', '',
        JSON.stringify(weights || {}),
      ]);
      continue;
    }

    // ââ Legacy GPT pick path (kept for backward compat) ââ
    // Normalize bet type â GPT sometimes returns "over"/"under" instead of "total"
    const isTotal = rawBetType === 'total' || rawBetType === 'totals' || rawBetType === 'over' || rawBetType === 'under';
    const isMoneyline = rawBetType === 'moneyline' || rawBetType === 'h2h';
    const isSpread = rawBetType === 'spread' || rawBetType === 'spreads';
    const betType = isTotal ? 'total' : isMoneyline ? 'moneyline' : isSpread ? 'spread' : rawBetType;

    // Confidence-scaled units with league/market performance modifier
    const baseUnits = confidenceToUnits(confidence);
    const modifier = getPerformanceModifier(sport, betType);
    let units = parseFloat((baseUnits * modifier).toFixed(3));

    // Enforce minimum stake.
    const minUnits = (weights && Number.isFinite(weights.param_min_units_to_bet))
      ? weights.param_min_units_to_bet
      : 0.01;
    if (!Number.isFinite(units) || units < minUnits) {
      units = minUnits;
    }

    // Try to find the game in odds data
    let game = gameLookup[team] || {};
    if (!game.away && isTotal) {
      const rationale = (p.rationale || '').toLowerCase();
      for (const [teamName, info] of Object.entries(gameLookup)) {
        if (rationale.includes(teamName.toLowerCase())) {
          game = info;
          break;
        }
      }
      if (!game.away) {
        const firstGame = Object.values(gameLookup)[0];
        if (firstGame) game = firstGame;
      }
    }
    const awayTeam = game.away || '';
    const homeTeam = game.home || '';
    const startTime = game.commence || '';
    const gameKey = game.gameKey || '';

    let odds = -110;
    let line = '';
    let pick = team;

    if (isMoneyline) {
      // Moneyline: odds from h2h market, no line
      const entry = oddsMap[`${team}|h2h`] || {};
      odds = entry.price || -110;
      line = '';  // moneyline has no line/point
      pick = team;

    } else if (isSpread) {
      // Spread: odds and point from spreads market
      const entry = oddsMap[`${team}|spreads`] || {};
      odds = entry.price || -110;
      line = entry.point || p.line || '';
      pick = team;

    } else if (isTotal) {
      // Total: determine Over/Under direction from GPT output
      const gptLine = String(p.line || '').toLowerCase();
      const gptRationale = String(p.rationale || '').toLowerCase();
      const isOver = rawBetType === 'over' || gptLine.includes('over') || gptRationale.includes('over');
      const direction = isOver ? 'Over' : 'Under';

      // Look up totals for this specific game first, then fall back to global
      let entry;
      if (gameKey) {
        entry = isOver
          ? gameOddsMap[`${gameKey}|Over|totals`]
          : gameOddsMap[`${gameKey}|Under|totals`];
      }
      if (!entry) {
        entry = isOver
          ? oddsMap['Over|totals']
          : oddsMap['Under|totals'];
      }
      entry = entry || {};
      odds = entry.price || -110;
      line = parseFloat(entry.point) || parseFloat(String(p.line).replace(/[^0-9.]/g, '')) || '';
      pick = line ? `${direction} ${line}` : direction;
    }

    // Heavy favorite cap: moneyline bets on favorites past -200 get capped to 0.01 units.
    // These win often but one upset wipes out 3-4 wins worth of profit (NBA ML: 71% win, -9.5% ROI).
    if (isMoneyline && odds < -200) {
      console.log(`[predictions] Heavy fav cap: ${pick} ML ${odds} â units capped to 0.01 (was ${units})`);
      units = 0.01;
    }

    // Absolute floor: no bet should ever have 0 units. If any calculation path
    // (modifier, rounding, heavy-fav cap, etc.) produces 0, force to 0.01.
    if (!Number.isFinite(units) || units <= 0) {
      units = 0.01;
    }

    console.log(`[predictions] Perf row: date=${dateStr} sport=${sport} betType=${betType} pick=${pick} odds=${odds} line=${line} units=${units} away=${awayTeam} home=${homeTeam}`);

    perfRows.push([
      dateStr,          // A: date
      sport,            // B: league
      betType,          // C: market (normalized)
      awayTeam,         // D: Away Team
      homeTeam,         // E: Home Team
      startTime,        // F: start_time
      betType,          // G: bet_type (normalized)
      pick,             // H: pick
      line,             // I: line
      odds,             // J: odds
      units,            // K: units
      `${confidence}%`, // L: confidence
      0,                // M: prediction_score
      0,                // N: Pre Away Score
      0,                // O: Pre Home Score
      0,                // P: Pre Total
      '',               // Q: result (empty â to be graded)
      '',               // R: unit_return (empty â to be graded)
      JSON.stringify(weights || {}), // S: weights_snapshot
    ]);
  }

  // COVERAGE BACKFILL: For every game in the odds data, ensure we have ML +
  // spread + total picks. If GPT skipped a market (common for totals), synthesize
  // a minimum-stake pick so every game is fully represented. Low confidence
  // picks are intentionally NOT dropped â see feedback_pick_coverage_rule.
  const minUnits = (weights && Number.isFinite(weights.param_min_units_to_bet))
    ? weights.param_min_units_to_bet
    : 0.01;
  const seenByGame = {}; // gameKey -> Set of betTypes
  for (const r of perfRows) {
    const gk = `${r[3]}@${r[4]}`;
    if (!seenByGame[gk]) seenByGame[gk] = new Set();
    seenByGame[gk].add(r[6]);
  }
  const seenGameKeys = new Set();
  const uniqueGames = [];
  for (const info of Object.values(gameLookup)) {
    if (!info || !info.gameKey || seenGameKeys.has(info.gameKey)) continue;
    seenGameKeys.add(info.gameKey);
    uniqueGames.push(info);
  }
  let backfilled = 0;
  for (const info of uniqueGames) {
    const gk = info.gameKey;
    const have = seenByGame[gk] || new Set();

    // ââ Moneyline backfill: pick favorite (lowest price â highest implied prob)
    if (!have.has('moneyline')) {
      const homeEntry = oddsMap[`${info.home}|h2h`] || gameOddsMap[`${gk}|${info.home}|h2h`];
      const awayEntry = oddsMap[`${info.away}|h2h`] || gameOddsMap[`${gk}|${info.away}|h2h`];
      let pickTeam = '', pickOdds = -110;
      if (homeEntry && awayEntry && homeEntry.price && awayEntry.price) {
        if (homeEntry.price <= awayEntry.price) {
          pickTeam = info.home; pickOdds = homeEntry.price;
        } else {
          pickTeam = info.away; pickOdds = awayEntry.price;
        }
      } else if (homeEntry && homeEntry.price) {
        pickTeam = info.home; pickOdds = homeEntry.price;
      } else if (awayEntry && awayEntry.price) {
        pickTeam = info.away; pickOdds = awayEntry.price;
      }
      if (pickTeam) {
        let units = Math.max(minUnits, 0.01);
        if (pickOdds < -200) units = 0.01; // heavy-fav cap
        perfRows.push([
          dateStr, sport, 'moneyline', info.away, info.home, info.commence,
          'moneyline', pickTeam, '', pickOdds, units, '1%', 0, 0, 0, 0, '', '',
          JSON.stringify(weights || {}),
        ]);
        backfilled++;
      }
    }

    // ââ Spread backfill: pick home team at their listed spread
    if (!have.has('spread')) {
      let entry = oddsMap[`${info.home}|spreads`] || gameOddsMap[`${gk}|${info.home}|spreads`];
      // Fallback: if no spreads odds (common for NHL), use sport default puckline/spread at -110
      const DEFAULT_SPREADS = { NHL: -1.5, NBA: -1.5, MLB: -1.5, NFL: -2.5 };
      if (!entry || !entry.price) {
        const defaultSpread = DEFAULT_SPREADS[sport];
        if (defaultSpread) entry = { price: -110, point: defaultSpread };
      }
      if (entry && entry.price) {
        const spreadUnits = Math.max(minUnits, 0.01);
        perfRows.push([
          dateStr, sport, 'spread', info.away, info.home, info.commence,
          'spread', info.home, entry.point || '', entry.price, spreadUnits, '1%', 0, 0, 0, 0, '', '',
          JSON.stringify(weights || {}),
        ]);
        backfilled++;
      }
    }

    // ââ Total backfill: prefer Over at per-game listed total
    // If no totals odds exist (common for NHL where API only returns h2h),
    // fall back to sport-specific default total lines.
    if (!have.has('total')) {
      let entry = gameOddsMap[`${gk}|Over|totals`] || oddsMap['Over|totals'];
      let direction = 'Over';
      if (!entry || !entry.price) {
        entry = gameOddsMap[`${gk}|Under|totals`] || oddsMap['Under|totals'];
        direction = 'Under';
      }
      // Fallback: if no totals odds at all, use sport default line at -110
      const DEFAULT_TOTALS = { NHL: 6, NBA: 220, MLB: 8.5, NFL: 44.5 };
      if (!entry || !entry.price) {
        const defaultLine = DEFAULT_TOTALS[sport];
        if (defaultLine) {
          entry = { price: -110, point: defaultLine };
          direction = 'Over';
        }
      }
      if (entry && entry.price) {
        const lineNum = parseFloat(entry.point) || '';
        const pick = lineNum ? `${direction} ${lineNum}` : direction;
        const totalUnits = Math.max(minUnits, 0.01);
        perfRows.push([
          dateStr, sport, 'total', info.away, info.home, info.commence,
          'total', pick, lineNum, entry.price, totalUnits, '1%', 0, 0, 0, 0, '', '',
          JSON.stringify(weights || {}),
        ]);
        backfilled++;
      }
    }
  }
  if (backfilled > 0) {
    console.log(`[predictions] ${sport}: coverage backfill added ${backfilled} minimum-stake picks across ${uniqueGames.length} games`);
  }

  // Dedup ALL markets: per game+market, keep the pick with highest confidence.
  // This catches duplicate totals (Over/Under on same game) AND duplicate
  // moneyline/spread picks (e.g. from trigger4+trigger5 overlap or GPT returning
  // the same game twice).
  const seenPicks = {};  // "gameKey|betType" -> index in perfRows
  const toRemove = new Set();
  for (let i = 0; i < perfRows.length; i++) {
    const row = perfRows[i];
    const betType = row[6]; // G: bet_type
    const gameKey = `${row[3]}@${row[4]}`; // D: away @ E: home
    const dedupKey = `${gameKey}|${betType}`;
    const conf = parseFloat(String(row[11]).replace('%', '')) || 0; // L: confidence
    const units = parseFloat(row[10]) || 0; // K: units (tiebreaker)
    if (seenPicks[dedupKey] !== undefined) {
      const prevIdx = seenPicks[dedupKey];
      const prevConf = parseFloat(String(perfRows[prevIdx][11]).replace('%', '')) || 0;
      const prevUnits = parseFloat(perfRows[prevIdx][10]) || 0;
      // Keep higher confidence; if tied, keep higher units (GPT-generated over backfill)
      if (conf > prevConf || (conf === prevConf && units > prevUnits)) {
        toRemove.add(prevIdx);
        seenPicks[dedupKey] = i;
        console.log(`[predictions] Dedup: removed duplicate ${betType} for ${gameKey} (kept conf ${conf}% over ${prevConf}%)`);
      } else {
        toRemove.add(i);
        console.log(`[predictions] Dedup: removed duplicate ${betType} for ${gameKey} (kept conf ${prevConf}% over ${conf}%)`);
      }
    } else {
      seenPicks[dedupKey] = i;
    }
  }
  const dedupedPerfRows = perfRows.filter((_, i) => !toRemove.has(i));

  if (dedupedPerfRows.length > 0) {
    // Prepend new picks at the top (after header row) instead of appending at bottom
    const existing = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
    const header = existing.length > 0 ? [existing[0]] : [];
    const oldRows = existing.slice(1);

    // Cross-trigger dedup: skip new rows that already exist in the Performance Log
    // (prevents duplicates if trigger4 and trigger5 both run, or if a trigger retries)
    const existingKeys = new Set();
    for (const row of oldRows) {
      const eDate = String(row[0] || '').slice(0, 10);
      const eSport = row[1] || '';
      const eAway = row[3] || '';
      const eHome = row[4] || '';
      const eBetType = row[6] || '';
      if (eSport === sport) existingKeys.add(`${eDate}|${eAway}@${eHome}|${eBetType}`);
    }
    const finalRows = dedupedPerfRows.filter(row => {
      const rDate = String(row[0] || '').slice(0, 10);
      const key = `${rDate}|${row[3]}@${row[4]}|${row[6]}`;
      return !existingKeys.has(key);
    });
    const crossDupes = dedupedPerfRows.length - finalRows.length;
    if (crossDupes > 0) {
      console.log(`[predictions] ${sport}: skipped ${crossDupes} picks already in Performance Log`);
    }

    if (finalRows.length > 0) {
      const newData = [...header, ...finalRows, ...oldRows];
      // Clear first to avoid stale row artifacts, then write the full dataset
      await clearSheet(SPREADSHEET_ID, SHEETS.PERFORMANCE);
      await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', newData);
      console.log(`[predictions] Logged ${finalRows.length} ${sport} picks to top of Performance Log (${perfRows.length - finalRows.length} duplicates removed)`);
    } else {
      console.log(`[predictions] ${sport}: all picks already exist in Performance Log, nothing new to write`);
    }

    // Dual-write to Supabase (non-blocking â log errors but don't fail the trigger)
    if (db.isEnabled() && finalRows && finalRows.length > 0) {
      try {
        const dbRows = finalRows.map(r => ({
          date: String(r[0] || '').replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'), // MM/DD/YYYY â YYYY-MM-DD
          league: r[1] || '',
          game: `${r[3]} @ ${r[4]}`,
          market: r[6] || '',
          pick: r[7] || '',
          line: parseFloat(r[4]) || null,
          odds: parseInt(r[9]) || null,
          confidence: parseInt(String(r[11]).replace('%', '')) || null,
          final_units: parseFloat(r[10]) || 0,
          modifier: getPerformanceModifier(r[1], r[6]),
          trigger_name: `trigger4_${sport}`,
        }));
        await db.insertPerformanceRows(dbRows);
        console.log(`[predictions] Dual-wrote ${dbRows.length} ${sport} picks to Supabase`);
      } catch (err) {
        console.warn(`[predictions] Supabase dual-write failed for ${sport}:`, err.message);
      }
    }
  }
}

// ââ CLV Snapshot âââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Take a closing line value snapshot.
 * Trigger 3 (part of fetchOddsAndGrade).
 */
async function takeCLVSnapshot() {
  console.log('[predictions] Taking CLV snapshot...');
  const oddsRows = await getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS);
  const ts = new Date().toISOString();
  const snapshotRows = oddsRows.slice(1).map(r => [ts, ...r]);
  if (snapshotRows.length > 0) {
    await appendRows(SPREADSHEET_ID, SHEETS.CLV_SNAPSHOT, snapshotRows);
    console.log(`[predictions] CLV snapshot: ${snapshotRows.length} rows`);
  }
}

// ââ Post-Game Grading ââââââââââââââââââââââââââââââââââââââââ

/**
 * Calculate the unit return for a graded bet.
 * @param {'W'|'L'|'P'} result
 * @param {number} units - units wagered
 * @param {number} odds - American odds (e.g. -110, +150)
 * @param {string} market - 'moneyline', 'spread', or 'total'
 */
function calculateUnitReturn(result, units, odds, market) {
  if (result === 'P') return 0;
  if (result === 'L') return -units;
  // Win
  if (market.toLowerCase() === 'moneyline') {
    // Moneyline uses actual odds for payout
    return odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
  }
  // Spread and total default to standard -110 juice (0.91 return)
  const effectiveOdds = odds || -110;
  return effectiveOdds > 0 ? units * (effectiveOdds / 100) : units * (100 / Math.abs(effectiveOdds));
}

/**
 * Determine bet result (W/L/P) based on market type and scores.
 * @param {string} market - 'moneyline', 'spread', or 'total'
 * @param {string} pick - team name or 'Over'/'Under'
 * @param {number} line - spread or total line
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {number} homeScore
 * @param {number} awayScore
 */
function determineBetResult(market, pick, line, homeTeam, awayTeam, homeScore, awayScore) {
  const mkt = market.toLowerCase();

  if (mkt === 'moneyline') {
    const pickTeam = pick.trim();
    if (homeScore === awayScore) return 'P';
    if (awayScore > homeScore && pickTeam === awayTeam) return 'W';
    if (homeScore > awayScore && pickTeam === homeTeam) return 'W';
    return 'L';
  }

  if (mkt === 'spread') {
    const lineNum = parseFloat(line) || 0;
    // Determine which team was picked
    const pickTeam = pick.includes(awayTeam) ? awayTeam : homeTeam;
    let adjustedAway = awayScore;
    let adjustedHome = homeScore;
    if (pickTeam === awayTeam) {
      adjustedAway += lineNum;
    } else {
      adjustedHome += lineNum;
    }
    if (adjustedAway === adjustedHome) return 'P';
    if (pickTeam === awayTeam && adjustedAway > adjustedHome) return 'W';
    if (pickTeam === homeTeam && adjustedHome > adjustedAway) return 'W';
    return 'L';
  }

  if (mkt === 'total') {
    const totalLine = parseFloat(line) || 0;
    const actualTotal = homeScore + awayScore;
    const pickType = pick.toLowerCase();
    if (actualTotal === totalLine) return 'P';
    if (pickType.includes('over') && actualTotal > totalLine) return 'W';
    if (pickType.includes('under') && actualTotal < totalLine) return 'W';
    return 'L';
  }

  return ''; // Unknown market
}

/**
 * Build a lookup map from the Closing_Odds_Snapshot sheet.
 * Each row in the snapshot is [snapshot_ts, ...originalOddsRow], where the
 * original odds row is: [ts, sport, home, away, commence, market, outcome, price, point, bookmaker]
 * We pick the most recent snapshot per (sport|away|home|market|outcome) combo.
 */
function buildClosingOddsMap(snapshotRows) {
  const map = {};
  if (!snapshotRows || snapshotRows.length < 2) return map;
  for (const row of snapshotRows.slice(1)) {
    // row[0] = snapshot_ts (added by takeCLVSnapshot)
    const sport = row[2] || '';
    const home = row[3] || '';
    const away = row[4] || '';
    const mktRaw = row[6] || '';
    const outcome = row[7] || '';
    const price = parseFloat(row[8]);
    const point = row[9] || '';
    if (!isFinite(price)) continue;
    // Normalize market label from Odds API -> internal
    const market = mktRaw === 'h2h' ? 'moneyline'
                 : mktRaw === 'spreads' ? 'spread'
                 : mktRaw === 'totals' ? 'total' : mktRaw;
    const key = `${sport}|${away}|${home}|${market}|${outcome}`;
    // Keep the latest snapshot (closest to game time = closing line)
    const existing = map[key];
    if (!existing || String(row[0]) > String(existing.ts)) {
      map[key] = { ts: row[0], price, point };
    }
  }
  return map;
}

/**
 * Look up the closing line for a graded bet and compute a CLV grade.
 * Grades:
 *   'good' = we beat the close (our price was better than the closing price)
 *   'flat' = within 5 cents
 *   'bad'  = we took worse-than-closing odds
 */
function lookupClosingOdds(closingMap, league, away, home, market, pick, line) {
  if (!closingMap) return null;
  const mkt = String(market || '').toLowerCase();
  let outcome;
  if (mkt === 'moneyline' || mkt === 'spread') {
    // outcome is the team name we picked
    outcome = pick.includes(away) ? away : home;
  } else if (mkt === 'total') {
    // "Over 8.5" -> "Over"
    outcome = String(pick).trim().split(/\s+/)[0];
  } else {
    return null;
  }
  const key = `${league}|${away}|${home}|${mkt}|${outcome}`;
  const close = closingMap[key];
  if (!close) return null;

  // Compute CLV grade by comparing implied probabilities
  // (higher implied probability = worse price for the bettor)
  // We need the original odds for this bet, which the caller has but we don't here.
  // So we just return the closing price/point and let the caller decide; we compute
  // a simple text grade based on price movement sign when possible.
  const closeLine = mkt === 'total' || mkt === 'spread' ? (close.point || '') : '';
  return {
    closeLine,
    closeOdds: close.price,
    grade: '', // populated post-hoc by compareClv when the caller supplies open odds
  };
}

/**
 * Given the open price we took and the closing price, return a CLV grade.
 * Positive = we beat the close (took better-than-closing odds).
 */
function gradeClvNumeric(openOdds, closeOdds) {
  if (!isFinite(openOdds) || !isFinite(closeOdds)) return '';
  const openImp = openOdds > 0 ? 100 / (openOdds + 100) : Math.abs(openOdds) / (Math.abs(openOdds) + 100);
  const closeImp = closeOdds > 0 ? 100 / (closeOdds + 100) : Math.abs(closeOdds) / (Math.abs(closeOdds) + 100);
  // If the closing price has a HIGHER implied probability than the open we took,
  // the market moved toward our side -> we beat the close -> 'good'.
  const delta = closeImp - openImp;
  if (delta > 0.01) return 'good';
  if (delta < -0.01) return 'bad';
  return 'flat';
}

/**
 * Grade ungraded bets in the Performance Log using Yesterday_Results.
 * Matches ANY ungraded bet (not just yesterday's) against available results
 * by league + away team + home team. This handles backfills and missed days.
 * Trigger 12: 11:00 PM ET daily (post-game).
 *
 * Performance Log columns (0-indexed):
 *   0: date, 1: league, 2: market, 3: awayTeam, 4: homeTeam,
 *   7: pick, 8: line, 9: odds, 10: units, 16: result (W/L/P), 17: unit_return
 */
async function gradePerformanceLog() {
  console.log('[predictions] Grading performance log from yesterday results...');

  // Read yesterday's results + closing-odds snapshot in parallel
  const [resultsRows, closingSnapRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS),
    getValues(SPREADSHEET_ID, SHEETS.CLV_SNAPSHOT).catch(() => []),
  ]);
  const closingMap = buildClosingOddsMap(closingSnapRows);
  console.log(`[predictions] CLV snapshot keys loaded: ${Object.keys(closingMap).length}`);
  if (!resultsRows || resultsRows.length < 2) {
    console.log('[predictions] No yesterday results to grade against');
    return { graded: 0 };
  }

  // Build results lookup: key = "LEAGUE|away|home"
  const resultsMap = {};
  for (const row of resultsRows.slice(1)) {
    const league = row[0] || '';
    const away = row[2] || '';
    const home = row[3] || '';
    const key = `${league}|${away}|${home}`;
    resultsMap[key] = {
      awayScore: parseFloat(row[4]) || 0,
      homeScore: parseFloat(row[5]) || 0,
    };
  }
  console.log(`[predictions] Loaded ${Object.keys(resultsMap).length} game results`);

  // Read Performance Log
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) {
    console.log('[predictions] Performance Log is empty');
    return { graded: 0 };
  }

  let graded = 0;
  const maxRows = Math.min(500, perfRows.length);

  for (let i = 1; i < maxRows; i++) {
    const row = perfRows[i];
    if (!row || row.length < 11) continue;

    // Skip if already graded (column Q / index 16)
    const existingResult = (row[16] || '').toString().trim();
    if (existingResult === 'W' || existingResult === 'L' || existingResult === 'P') continue;

    const league = row[1] || '';
    const market = row[2] || '';
    const awayTeam = row[3] || '';
    const homeTeam = row[4] || '';
    const pick = row[7] || '';
    const line = row[8];
    const odds = parseFloat(row[9]) || -110;
    // Stake: accept legitimate zeros, skip garbage/NaN. Do NOT fall back to 1 â
    // that turned a stake-0 bug into phantom -1.00 losses in historical data.
    const unitsRaw = parseFloat(row[10]);
    const units = Number.isFinite(unitsRaw) ? unitsRaw : 0;

    if (!league || !awayTeam || !homeTeam || !pick) continue;

    // Find matching result
    const key = `${league}|${awayTeam}|${homeTeam}`;
    const result = resultsMap[key];
    if (!result) continue;

    // Grade the bet
    const betResult = determineBetResult(market, pick, line, homeTeam, awayTeam, result.homeScore, result.awayScore);
    if (!betResult) continue;

    const unitReturn = calculateUnitReturn(betResult, units, odds, market);

    // CLV lookup: match this bet to the closing-odds snapshot.
    // Key format mirrors the snapshot row layout from takeCLVSnapshot.
    const clvInfo = lookupClosingOdds(closingMap, league, awayTeam, homeTeam, market, pick, line);

    // Write result + unit return back to the row
    // Column Q = index 16, Column R = index 17
    // Columns AE = 30 (close_line), AF = 31 (close_odds), AG = 32 (clv_grade)
    // Column 28 = Pulled Date, 29 = (blank). CLV triplet lives at 30/31/32.
    while (perfRows[i].length < 33) perfRows[i].push('');
    perfRows[i][16] = betResult;
    perfRows[i][17] = parseFloat(unitReturn.toFixed(2));
    if (clvInfo) {
      perfRows[i][30] = clvInfo.closeLine;
      perfRows[i][31] = clvInfo.closeOdds;
      perfRows[i][32] = gradeClvNumeric(odds, clvInfo.closeOdds);
    }

    graded++;
    console.log(`[predictions] Row ${i + 1}: ${betResult} â ${awayTeam} @ ${homeTeam} (${market}) â ${unitReturn.toFixed(2)} units`);
  }

  if (graded > 0) {
    // Write back the full Performance Log with grades applied
    await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', perfRows);
    console.log(`[predictions] Grading complete: ${graded} bets graded`);
  } else {
    console.log('[predictions] No bets matched yesterday\'s results');
  }

  return { graded };
}

module.exports = {
  generateMLBPredictions,
  generateNBAPredictions,
  generateNHLPredictions,
  generateNFLPredictions,
  takeCLVSnapshot,
  gradePerformanceLog,
  // exported for tests / offline tools
  buildClosingOddsMap,
  lookupClosingOdds,
  gradeClvNumeric,
  calculateUnitReturn,
  determineBetResult,
};
