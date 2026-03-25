'use strict';
// =============================================================
// src/predictions.js — Core prediction logic
// Replaces: Predictions (Apps Script)
// =============================================================

const OpenAI = require('openai');
const { SPREADSHEET_ID, SHEETS, OPENAI_API_KEY, IS_TEST } = require('./config');
const { getValues, setValues, clearSheet, appendRows } = require('./sheets');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Helpers ─────────────────────────────────────────────────────

function getTargetSheet(baseSheet) {
  return IS_TEST ? SHEETS['TEST_' + baseSheet.replace('Predictions', '')] || baseSheet : baseSheet;
}

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

  // Filter to MLB games today
  const today = new Date().toISOString().split('T')[0];
  const mlbOdds = oddsRows.slice(1).filter(r => r[1] === 'MLB' && (r[4] || '').startsWith(today));

  if (mlbOdds.length === 0) {
    console.log('[predictions] No MLB games today, skipping.');
    return;
  }

  // Build context for OpenAI
  const weights = {};
  for (const [k, v] of weightRows.slice(1)) { weights[k] = parseFloat(v) || 0; }
  
  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const gamesContext = mlbOdds.slice(0, 10).map(r =>
    `${r[2]} vs ${r[3]}: ${r[5]} ${r[6]} @ ${r[7]}`
  ).join('\n');

  const prompt = `You are a sports betting analyst. Based on today's MLB odds and team stats, 
generate 3-5 best bets. For each pick provide: team, bet type, confidence (1-10), brief rationale.

Today's games:
${gamesContext}

Team records (Win-Loss):
${Object.entries(teamsMap).slice(0, 20).map(([t, r]) => `${t}: ${r.wins}-${r.losses}`).join('\n')}

Weight priorities: ${JSON.stringify(weights)}

Format as JSON array: [{team, betType, line, confidence, rationale}]`;

  let picks = [];
  try {
    const completion = await openai.chat.completions.create({
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

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'MLB', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.MLB_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] MLB: ${picks.length} picks written to ${targetSheet}`);
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

  const today = new Date().toISOString().split('T')[0];
  const nbaOdds = oddsRows.slice(1).filter(r => r[1] === 'NBA' && (r[4] || '').startsWith(today));

  if (nbaOdds.length === 0) {
    console.log('[predictions] No NBA games today, skipping.');
    return;
  }

  // Build weight context
  const weights = {};
  for (const [k, v] of weightRows.slice(1)) { weights[k] = parseFloat(v) || 0; }

  // Build team records context
  const teamsMap = {};
  for (const row of teamRows.slice(1)) {
    teamsMap[row[2]] = { wins: row[4], losses: row[5], pct: row[6] };
  }

  const gamesContext = nbaOdds.slice(0, 10).map(r =>
    `${r[2]} vs ${r[3]}: ${r[5]} ${r[6]} @ ${r[7]}`
  ).join('\n');

  const prompt = `You are a sports betting analyst. Based on today's NBA odds and team stats,
generate 3-5 best bets. For each pick provide: team, bet type, confidence (1-10), brief rationale.

Today's NBA games:
${gamesContext}

Team records (Win-Loss):
${Object.entries(teamsMap).slice(0, 20).map(([t, r]) => `${t}: ${r.wins}-${r.losses}`).join('\n')}

Weight priorities: ${JSON.stringify(weights)}

Format as JSON: {picks: [{team, betType, line, confidence, rationale}]}`;

  let picks = [];
  try {
    const completion = await openai.chat.completions.create({
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

  const ts = new Date().toISOString();
  const rows = [['Timestamp', 'Sport', 'Team', 'BetType', 'Line', 'Confidence', 'Rationale']];
  for (const p of picks) {
    rows.push([ts, 'NBA', p.team || '', p.betType || '', p.line || '', p.confidence || '', p.rationale || '']);
  }

  const targetSheet = getTargetSheet(SHEETS.NBA_PREDICTIONS);
  await clearSheet(SPREADSHEET_ID, targetSheet);
  await setValues(SPREADSHEET_ID, targetSheet, 'A1', rows);
  console.log(`[predictions] NBA: ${picks.length} picks written to ${targetSheet}`);
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
 * Grade bets in the Performance Log using Yesterday_Results.
 * Reads yesterday's scores, matches to ungraded bets, writes W/L/P + unit return.
 * Trigger 12: 11:00 PM ET daily (post-game).
 *
 * Performance Log columns (0-indexed):
 *   0: date, 1: league, 2: market, 3: awayTeam, 4: homeTeam,
 *   7: pick, 8: line, 9: odds, 10: units, 16: result (W/L/P), 17: unit_return
 */
async function gradePerformanceLog() {
  console.log('[predictions] Grading performance log from yesterday results...');

  // Read yesterday's results
  const resultsRows = await getValues(SPREADSHEET_ID, SHEETS.YESTERDAY_RESULTS);
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

  // Get yesterday's date string for matching
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD

  let graded = 0;
  const maxRows = Math.min(500, perfRows.length);

  for (let i = 1; i < maxRows; i++) {
    const row = perfRows[i];
    if (!row || row.length < 11) continue;

    // Skip if already graded (column Q / index 16)
    const existingResult = (row[16] || '').toString().trim();
    if (existingResult === 'W' || existingResult === 'L' || existingResult === 'P') continue;

    // Check if bet is from yesterday
    const betDate = row[0] || '';
    let betDateStr = '';
    if (betDate) {
      // Handle both ISO dates and M/d/yyyy format
      const d = new Date(betDate);
      if (!isNaN(d.getTime())) {
        betDateStr = d.toISOString().split('T')[0];
      }
    }
    if (betDateStr !== yesterdayStr) continue;

    const league = row[1] || '';
    const market = row[2] || '';
    const awayTeam = row[3] || '';
    const homeTeam = row[4] || '';
    const pick = row[7] || '';
    const line = row[8];
    const odds = parseFloat(row[9]) || -110;
    const units = parseFloat(row[10]) || 1;

    // Find matching result
    const key = `${league}|${awayTeam}|${homeTeam}`;
    const result = resultsMap[key];
    if (!result) continue;

    // Grade the bet
    const betResult = determineBetResult(market, pick, line, homeTeam, awayTeam, result.homeScore, result.awayScore);
    if (!betResult) continue;

    const unitReturn = calculateUnitReturn(betResult, units, odds, market);

    // Write result + unit return back to the row
    // Column Q = index 16, Column R = index 17
    // Ensure row has enough columns
    while (perfRows[i].length < 18) perfRows[i].push('');
    perfRows[i][16] = betResult;
    perfRows[i][17] = parseFloat(unitReturn.toFixed(2));

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
  takeCLVSnapshot,
  gradePerformanceLog,
};
