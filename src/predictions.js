'use strict';
// =============================================================
// src/predictions.js — Core prediction logic
// Replaces: Predictions (Apps Script)
// =============================================================

const OpenAI = require('openai');
const { SPREADSHEET_ID, SHEETS, OPENAI_API_KEY, IS_TEST } = require('./config');
const { getValues, setValues, clearSheet, appendRows } = require('./sheets');
const { parseWeightRows, sheetForLeague } = require('./weights');

// Lazy-init so importing this module for testing/tools doesn't require a key.
let _openai = null;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  return _openai;
}

// ── Helpers ─────────────────────────────────────────────────────

function getTargetSheet(baseSheet) {
  return IS_TEST ? SHEETS['TEST_' + baseSheet.replace('Predictions', '')] || baseSheet : baseSheet;
}

/**
 * Convert American odds to implied probability (0-1).
 */
function impliedProbability(americanOdds) {
  const o = parseFloat(americanOdds);
  if (isNaN(o)) return 0;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
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
 * Scale: 1-2 → 0.01, 3-4 → 0.05, 5 → 0.1, 6-7 → 0.15, 8 → 0.2, 9 → 0.4, 10 → 0.5
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
  'NHL|spread':     1.15,  // 30d: 53.2% / +10.6% ROI (n=250) — boost
  'NHL|moneyline':  1.15,  // 30d: 56.4% / +13.5% ROI (n=250) — boost
  'NHL|total':      1.35,  // 30d: 52.8% / +13.0% ROI (n=196) — boost
  'NBA|spread':     1.05,  // 30d: 55.3% / +6.9% ROI (n=204) — slight boost
  'NBA|moneyline':  0.3,   // HOLD — data corrupted by stake=0 bug, re-evaluate after fix
  'NBA|total':      0.7,   // 30d: 45.5% / -11.6% ROI (n=167) — cut hard
  'MLB|spread':     0.7,   // 30d: 44.2% / -17.3% ROI (n=138) — cut hard, biggest bleeder
  'MLB|moneyline':  0.6,   // 30d: 52.2% / -3.6% ROI (n=136) — reduce 15%
  'MLB|total':      0.5,   // 30d: 53.8% / -2.1% ROI (n=92) — hold
  'NFL|spread':     1.0,   // no recent NFL activity
  'NFL|moneyline':  0.8,
  'NFL|total':      0.9,
};

function getPerformanceModifier(league, betType) {
  const key = `${league}|${betType.toLowerCase()}`;
  return PERFORMANCE_MODIFIERS[key] || 1.0;
}

// No minimum confidence filter — every game gets all 3 market picks.
// Low-confidence picks use minimal units (0.01) instead of being excluded.

// ── MLB Predictions ─────────────────────────────────────────────

/**
 * Generate MLB picks using weights + OpenAI.
 * Trigger 4 (Part 1): 5:00 AM ET daily
 */
async function generateMLBPredictions() {
  console.log('[predictions] Generating MLB predictions...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS),
    getValues(SPREADSHEET_ID, SHEETS.TEAM_STATS),
  ]);

  // Build deduplicated game objects with consensus odds
  const games = buildGameObjects(oddsRows, 'MLB');
  console.log(`[predictions] MLB: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No MLB games, skipping.');
    return;
  }

  // Build weight context — correct 3-col schema [market, key, value]
  const parsedWeights = parseWeightRows(weightRows);
  const weights = parsedWeights.flat;

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  // Build structured game context with all market odds
  const gamesContext = games.map(g => {
    const lines = [`${g.away} @ ${g.home} (${g.commence})`];
    for (const [mkt, outcomes] of Object.entries(g.markets)) {
      for (const o of outcomes) {
        const label = mkt === 'h2h' ? 'ML' : mkt === 'spreads' ? 'Spread' : 'Total';
        const pointStr = o.point ? ` ${o.point}` : '';
        lines.push(`  ${label}: ${o.outcome}${pointStr} → ${o.price} (implied ${(o.impliedProb * 100).toFixed(1)}%)`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');

  const prompt = `You are an expert sports betting value analyst. Your job is to find EDGES — situations where your estimated probability of an outcome differs meaningfully from the implied probability of the odds.

Today's MLB games with consensus odds and implied probabilities:

${gamesContext}

Team records:
${Object.entries(teamsMap).slice(0, 30).map(([t, r]) => `${t}: ${r.wins}-${r.losses} (${r.pct})`).join('\n')}

Weight priorities: ${JSON.stringify(weights)}

INSTRUCTIONS:
1. For EVERY game, you MUST provide exactly 3 picks: one spread, one moneyline, and one total (over/under). No exceptions.
2. For each pick, estimate the TRUE probability of the chosen side based on team strength, matchups, and context.
3. Compare your estimated probability to the IMPLIED probability from the odds to determine the edge.
4. Confidence (1-10) should reflect the size of the edge. Even if you see no edge, pick the side you lean toward and give it a low confidence (1-3).
5. For totals, pick EITHER "over" OR "under" (never both) as the betType and include the total line number. Only ONE total pick per game.

Format as JSON: {"picks": [{"team": "Team Name", "betType": "moneyline|spread|over|under", "line": "spread/total number or empty for ML", "confidence": 7, "rationale": "Edge: estimated 58% vs implied 52%. Reason..."}]}

IMPORTANT: Return exactly ${games.length * 3} picks (3 per game: 1 spread + 1 moneyline + 1 total). Do NOT return both over and under for the same game — pick one direction only.`;

  let picks = [];
  try {
    const completion = await openai().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    picks = parsed.picks || parsed.bets || parsed.recommendations || [];
  } catch (err) {
    console.error('[predictions] OpenAI error:', err.message);
  }

  console.log(`[predictions] MLB: ${picks.length} picks returned (expected ${games.length * 3})`);

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'MLB', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.MLB_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] MLB: ${picks.length} picks written to ${targetSheet}`);

  // Log to Performance Log for grading
  await logPicksToPerformanceLog(picks, 'MLB', oddsRows, weights);
}

// ── NBA Predictions ─────────────────────────────────────────────

/**
 * Generate NBA picks.
 * Trigger 4 (Part 2) / Trigger 5: continues after MLB
 */
async function generateNBAPredictions() {
  console.log('[predictions] Generating NBA predictions...');

  const [oddsRows, weightRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.WEIGHTS_NBA),
    getValues(SPREADSHEET_ID, SHEETS.NBA_TEAM_STATS),
  ]);

  // Build deduplicated game objects with consensus odds
  const games = buildGameObjects(oddsRows, 'NBA');
  console.log(`[predictions] NBA: ${games.length} unique games found`);
  if (games.length === 0) {
    console.log('[predictions] No NBA games, skipping.');
    return;
  }

  // Build weight context — correct 3-col schema [market, key, value]
  const parsedWeights = parseWeightRows(weightRows);
  const weights = parsedWeights.flat;

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  // Build structured game context with all market odds
  const gamesContext = games.map(g => {
    const lines = [`${g.away} @ ${g.home} (${g.commence})`];
    for (const [mkt, outcomes] of Object.entries(g.markets)) {
      for (const o of outcomes) {
        const label = mkt === 'h2h' ? 'ML' : mkt === 'spreads' ? 'Spread' : 'Total';
        const pointStr = o.point ? ` ${o.point}` : '';
        lines.push(`  ${label}: ${o.outcome}${pointStr} → ${o.price} (implied ${(o.impliedProb * 100).toFixed(1)}%)`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');

  const prompt = `You are an expert sports betting value analyst. Your job is to find EDGES — situations where your estimated probability of an outcome differs meaningfully from the implied probability of the odds.

Today's NBA games with consensus odds and implied probabilities:

${gamesContext}

Team records:
${Object.entries(teamsMap).slice(0, 30).map(([t, r]) => `${t}: ${r.wins}-${r.losses} (${r.pct})`).join('\n')}

Weight priorities: ${JSON.stringify(weights)}

INSTRUCTIONS:
1. For EVERY game, you MUST provide exactly 3 picks: one spread, one moneyline, and one total (over/under). No exceptions.
2. For each pick, estimate the TRUE probability of the chosen side based on team strength, matchups, recent form, and context.
3. Compare your estimated probability to the IMPLIED probability from the odds to determine the edge.
4. Confidence (1-10) should reflect the size of the edge. Even if you see no edge, pick the side you lean toward and give it a low confidence (1-3).
5. NBA moneyline has historically been our weakest market (-4.8% ROI). Be extra critical when assigning moneyline confidence — only give high confidence (7+) if the edge is very clear.
6. For totals, pick EITHER "over" OR "under" (never both) as the betType and include the total line number. Only ONE total pick per game.

Format as JSON: {"picks": [{"team": "Team Name", "betType": "moneyline|spread|over|under", "line": "spread/total number or empty for ML", "confidence": 7, "rationale": "Edge: estimated 58% vs implied 52%. Reason..."}]}

IMPORTANT: Return exactly ${games.length * 3} picks (3 per game: 1 spread + 1 moneyline + 1 total). Do NOT return both over and under for the same game — pick one direction only.`;

  let picks = [];
  try {
    const completion = await openai().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    picks = parsed.picks || parsed.bets || [];
  } catch (err) {
    console.error('[predictions] OpenAI NBA error:', err.message);
  }

  console.log(`[predictions] NBA: ${picks.length} picks returned (expected ${games.length * 3})`);

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'NBA', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.NBA_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] NBA: ${picks.length} picks written to ${targetSheet}`);

  // Log to Performance Log for grading
  await logPicksToPerformanceLog(picks, 'NBA', oddsRows, weights);
}

// ── NHL Predictions ─────────────────────────────────────────────

/**
 * Generate NHL picks — 3 per game (spread, moneyline, total).
 * Trigger 4 extension or dedicated trigger.
 */
async function generateNHLPredictions() {
  console.log('[predictions] Generating NHL predictions...');

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

  const weights = {};
  for (const [k, v] of weightRows.slice(1)) { weights[k] = parseFloat(v) || 0; }

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const gamesContext = games.map(g => {
    const lines = [`${g.away} @ ${g.home} (${g.commence})`];
    for (const [mkt, outcomes] of Object.entries(g.markets)) {
      for (const o of outcomes) {
        const label = mkt === 'h2h' ? 'ML' : mkt === 'spreads' ? 'Spread' : 'Total';
        const pointStr = o.point ? ` ${o.point}` : '';
        lines.push(`  ${label}: ${o.outcome}${pointStr} → ${o.price} (implied ${(o.impliedProb * 100).toFixed(1)}%)`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');

  const prompt = `You are an expert sports betting value analyst. Your job is to find EDGES — situations where your estimated probability of an outcome differs meaningfully from the implied probability of the odds.

Today's NHL games with consensus odds and implied probabilities:

${gamesContext}

Team records:
${Object.entries(teamsMap).slice(0, 32).map(([t, r]) => `${t}: ${r.wins}-${r.losses} (${r.pct})`).join('\n')}

Weight priorities: ${JSON.stringify(weights)}

INSTRUCTIONS:
1. For EVERY game, you MUST provide exactly 3 picks: one spread (puckline), one moneyline, and one total (over/under). No exceptions.
2. NHL spread is our historically strongest market (59.3% cover, +18.5% ROI). Give extra attention to puckline value.
3. For each pick, estimate the TRUE probability and compare to implied probability to find edges.
4. Confidence (1-10) should reflect the size of the edge. Even if you see no edge, pick the side you lean toward and give it a low confidence (1-3).
5. For totals, pick EITHER "over" OR "under" (never both) as the betType and include the total line number. Only ONE total pick per game.

Format as JSON: {"picks": [{"team": "Team Name", "betType": "moneyline|spread|over|under", "line": "spread/total number or empty for ML", "confidence": 7, "rationale": "Edge: estimated 58% vs implied 52%. Reason..."}]}

IMPORTANT: Return exactly ${games.length * 3} picks (3 per game: 1 spread + 1 moneyline + 1 total). Do NOT return both over and under for the same game — pick one direction only.`;

  let picks = [];
  try {
    const completion = await openai().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    picks = parsed.picks || parsed.bets || [];
  } catch (err) {
    console.error('[predictions] OpenAI NHL error:', err.message);
  }

  console.log(`[predictions] NHL: ${picks.length} picks returned (expected ${games.length * 3})`);

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'NHL', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  // NHL doesn't have a dedicated predictions tab — write to NHL Team Stats area or a generic output
  // For now, log directly to Performance Log (the primary tracking mechanism)
  await logPicksToPerformanceLog(picks, 'NHL', oddsRows, weights);
  console.log(`[predictions] NHL: ${picks.length} picks logged to Performance Log`);
}

// ── NFL Predictions ─────────────────────────────────────────────

/**
 * Generate NFL picks — 3 per game (spread, moneyline, total).
 * Only runs during NFL season (Sep-Feb).
 */
async function generateNFLPredictions() {
  console.log('[predictions] Generating NFL predictions...');

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

  const weights = {};
  for (const [k, v] of weightRows.slice(1)) { weights[k] = parseFloat(v) || 0; }

  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const gamesContext = games.map(g => {
    const lines = [`${g.away} @ ${g.home} (${g.commence})`];
    for (const [mkt, outcomes] of Object.entries(g.markets)) {
      for (const o of outcomes) {
        const label = mkt === 'h2h' ? 'ML' : mkt === 'spreads' ? 'Spread' : 'Total';
        const pointStr = o.point ? ` ${o.point}` : '';
        lines.push(`  ${label}: ${o.outcome}${pointStr} → ${o.price} (implied ${(o.impliedProb * 100).toFixed(1)}%)`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');

  const prompt = `You are an expert sports betting value analyst. Your job is to find EDGES — situations where your estimated probability of an outcome differs meaningfully from the implied probability of the odds.

Today's NFL games with consensus odds and implied probabilities:

${gamesContext}

Team records:
${Object.entries(teamsMap).slice(0, 32).map(([t, r]) => `${t}: ${r.wins}-${r.losses} (${r.pct})`).join('\n')}

Weight priorities: ${JSON.stringify(weights)}

INSTRUCTIONS:
1. For EVERY game, you MUST provide exactly 3 picks: one spread, one moneyline, and one total (over/under). No exceptions.
2. For each pick, estimate the TRUE probability and compare to implied probability to find edges.
3. Confidence (1-10) should reflect the size of the edge. Even if you see no edge, pick the side you lean toward and give it a low confidence (1-3).
4. For totals, pick EITHER "over" OR "under" (never both) as the betType and include the total line number. Only ONE total pick per game.

Format as JSON: {"picks": [{"team": "Team Name", "betType": "moneyline|spread|over|under", "line": "spread/total number or empty for ML", "confidence": 7, "rationale": "Edge: estimated 58% vs implied 52%. Reason..."}]}

IMPORTANT: Return exactly ${games.length * 3} picks (3 per game: 1 spread + 1 moneyline + 1 total). Do NOT return both over and under for the same game — pick one direction only.`;

  let picks = [];
  try {
    const completion = await openai().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    picks = parsed.picks || parsed.bets || [];
  } catch (err) {
    console.error('[predictions] OpenAI NFL error:', err.message);
  }

  console.log(`[predictions] NFL: ${picks.length} picks returned (expected ${games.length * 3})`);

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'NFL', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  await logPicksToPerformanceLog(picks, 'NFL', oddsRows, weights);
  console.log(`[predictions] NFL: ${picks.length} picks logged to Performance Log`);
}

// ── Performance Log Writer ───────────────────────────────────────

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

  // Build odds lookup by team name for matching — store game info + per-game odds
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

  // Minimum confidence threshold from the league's weights sheet.
  // Threshold is stored as a 0-1 value (e.g. 0.60 = GPT confidence >= 6 on 1-10 scale).
  // If undefined, no filter is applied (matches pre-fix behavior).
  const minConfRaw = weights && Number.isFinite(weights.param_min_confidence_to_bet)
    ? weights.param_min_confidence_to_bet
    : null;

  const perfRows = [];
  let droppedLowConf = 0;
  for (const p of picks) {
    const team = p.team || '';
    const rawBetType = (p.betType || '').toLowerCase();
    const confidence = p.confidence || '';

    // Apply min-confidence filter. GPT confidence is 1-10; threshold is 0-1.
    // conf 7 → 0.7; threshold 0.6 passes, 0.8 fails.
    if (minConfRaw != null) {
      const confAsRatio = (parseFloat(confidence) || 0) / 10;
      if (confAsRatio < minConfRaw) {
        droppedLowConf++;
        continue;
      }
    }

    // Normalize bet type — GPT sometimes returns "over"/"under" instead of "total"
    const isTotal = rawBetType === 'total' || rawBetType === 'totals' || rawBetType === 'over' || rawBetType === 'under';
    const isMoneyline = rawBetType === 'moneyline' || rawBetType === 'h2h';
    const isSpread = rawBetType === 'spread' || rawBetType === 'spreads';
    const betType = isTotal ? 'total' : isMoneyline ? 'moneyline' : isSpread ? 'spread' : rawBetType;

    // Confidence-scaled units with league/market performance modifier
    const baseUnits = confidenceToUnits(confidence);
    const modifier = getPerformanceModifier(sport, betType);
    let units = parseFloat((baseUnits * modifier).toFixed(3));

    // Enforce minimum stake. If the weights sheet defines param_min_units_to_bet,
    // use that; otherwise default to 0.01. This prevents 0-unit bets from being
    // logged (which the grader previously mis-counted as 1-unit losses).
    const minUnits = (weights && Number.isFinite(weights.param_min_units_to_bet))
      ? weights.param_min_units_to_bet
      : 0.01;
    if (!Number.isFinite(units) || units < minUnits) {
      units = minUnits;
    }

    // Try to find the game in odds data
    // For totals, GPT may not return a real team name — try team first,
    // then search gameLookup for any partial match from the rationale,
    // then fall back to the first available game for this sport
    let game = gameLookup[team] || {};
    if (!game.away && isTotal) {
      // Try to find game from team name mentioned in rationale or line
      const rationale = (p.rationale || '').toLowerCase();
      for (const [teamName, info] of Object.entries(gameLookup)) {
        if (rationale.includes(teamName.toLowerCase())) {
          game = info;
          break;
        }
      }
      // Last resort: use the first game available (works when there's only one game)
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
      console.log(`[predictions] Heavy fav cap: ${pick} ML ${odds} → units capped to 0.01 (was ${units})`);
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
      '',               // Q: result (empty — to be graded)
      '',               // R: unit_return (empty — to be graded)
      JSON.stringify(weights || {}), // S: weights_snapshot
    ]);
  }

  if (droppedLowConf > 0) {
    console.log(`[predictions] Dropped ${droppedLowConf} ${sport} picks below min confidence ${minConfRaw}`);
  }

  // Dedup totals: if GPT returned both Over and Under for the same game, keep higher confidence
  const seenTotals = {};  // gameKey -> index in perfRows
  const toRemove = new Set();
  for (let i = 0; i < perfRows.length; i++) {
    const row = perfRows[i];
    const betType = row[6]; // G: bet_type
    if (betType !== 'total') continue;
    const gameKey = `${row[3]}@${row[4]}`; // D: away @ E: home
    const conf = parseFloat(String(row[11]).replace('%', '')) || 0; // L: confidence
    if (seenTotals[gameKey] !== undefined) {
      const prevIdx = seenTotals[gameKey];
      const prevConf = parseFloat(String(perfRows[prevIdx][11]).replace('%', '')) || 0;
      if (conf > prevConf) {
        toRemove.add(prevIdx);
        seenTotals[gameKey] = i;
        console.log(`[predictions] Dedup: removed duplicate total for ${gameKey} (kept conf ${conf}% over ${prevConf}%)`);
      } else {
        toRemove.add(i);
        console.log(`[predictions] Dedup: removed duplicate total for ${gameKey} (kept conf ${prevConf}% over ${conf}%)`);
      }
    } else {
      seenTotals[gameKey] = i;
    }
  }
  const dedupedPerfRows = perfRows.filter((_, i) => !toRemove.has(i));

  if (dedupedPerfRows.length > 0) {
    // Prepend new picks at the top (after header row) instead of appending at bottom
    const existing = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
    const header = existing.length > 0 ? [existing[0]] : [];
    const oldRows = existing.slice(1);
    const newData = [...header, ...dedupedPerfRows, ...oldRows];
    // Clear first to avoid stale row artifacts, then write the full dataset
    await clearSheet(SPREADSHEET_ID, SHEETS.PERFORMANCE);
    await setValues(SPREADSHEET_ID, SHEETS.PERFORMANCE, 'A1', newData);
    console.log(`[predictions] Logged ${dedupedPerfRows.length} ${sport} picks to top of Performance Log (${perfRows.length - dedupedPerfRows.length} duplicate totals removed)`);
  }
}

// ── CLV Snapshot ─────────────────────────────────────────────────

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

// ── Post-Game Grading ────────────────────────────────────────

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
    // Stake: accept legitimate zeros, skip garbage/NaN. Do NOT fall back to 1 —
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
    // Columns AD = 29 (close_line), AE = 30 (close_odds), AF = 31 (clv_grade)
    // (these match the headers seen in the Performance Log)
    while (perfRows[i].length < 32) perfRows[i].push('');
    perfRows[i][16] = betResult;
    perfRows[i][17] = parseFloat(unitReturn.toFixed(2));
    if (clvInfo) {
      perfRows[i][29] = clvInfo.closeLine;
      perfRows[i][30] = clvInfo.closeOdds;
      perfRows[i][31] = gradeClvNumeric(odds, clvInfo.closeOdds);
    }

    graded++;
    console.log(`[predictions] Row ${i + 1}: ${betResult} — ${awayTeam} @ ${homeTeam} (${market}) — ${unitReturn.toFixed(2)} units`);
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
