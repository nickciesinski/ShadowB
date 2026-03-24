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

  const [oddsRows, teamRows] = await Promise.all([
    getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS),
    getValues(SPREADSHEET_ID, SHEETS.TEAM_STATS),
  ]);

  const today = new Date().toISOString().split('T')[0];
  const nbaOdds = oddsRows.slice(1).filter(r => r[1] === 'NBA' && (r[4] || '').startsWith(today));

  if (nbaOdds.length === 0) {
    console.log('[predictions] No NBA games today, skipping.');
    return;
  }

  const gamesContext = nbaOdds.slice(0, 10).map(r =>
    `${r[2]} vs ${r[3]}: ${r[5]} ${r[6]} @ ${r[7]}`
  ).join('\n');

  const prompt = `You are a sports betting analyst. Based on today's NBA odds, 
generate 3-5 best bets. Format as JSON: {picks: [{team, betType, line, confidence, rationale}]}

Today's NBA games:
${gamesContext}`;

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

module.exports = {
  generateMLBPredictions,
  generateNBAPredictions,
  takeCLVSnapshot,
};
