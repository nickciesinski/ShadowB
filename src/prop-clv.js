'use strict';
/**
 * prop-clv.js — Prop CLV Tracking & Learning Loop
 *
 * Three responsibilities:
 * 1. snapPropLines()       — save opening edges right after generatePropEdges()
 * 2. gradePropEdges()      — after games end, compare opening vs closing lines
 * 3. updatePropWeights()   — nightly auto-adjust market weights based on CLV data
 *
 * CLV (Closing Line Value) is the primary learning signal. If you grabbed
 * a prop edge at +120 and it closed at -110, the market moved your way —
 * that's a CLV "hit." Markets that consistently beat closing lines get
 * boosted; markets that don't get cut.
 *
 * This is the same feedback loop the main picks system uses, but adapted
 * for the prop domain where markets are more granular (batter_hits, player_points, etc.).
 */
const { getValues, setValues, clearSheet, appendRows } = require('./sheets');
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, SPORTS } = require('./config');
const { readPropWeights, writePropWeights, computeWeightUpdates, propSheetForLeague } = require('./prop-weights');
const { logApiCall } = require('./monitoring');

const ODDS_API_COST = 0.001;

/**
 * Snapshot opening prop edges right after edge calculation.
 * Called from trigger8 (after generatePropEdges in trigger7).
 * Reads Prop_Combos and archives to Prop_CLV_Opening for later comparison.
 */
async function snapPropLines() {
  console.log('[prop-clv] Snapshotting opening prop lines...');

  const combos = await getValues(SPREADSHEET_ID, SHEETS.PROP_COMBOS);
  if (!combos || combos.length < 2) {
    console.log('[prop-clv] No prop edges to snapshot.');
    return;
  }

  const ts = new Date().toISOString();
  const snapRows = [['Timestamp', 'League', 'Player', 'Market', 'Line', 'Direction',
    'Book', 'BookOdds', 'BookProb', 'ConsensusProb', 'Edge', 'Game',
    'AdjustedEdge', 'Confidence', 'Units']];

  // Prop_Combos columns: 0=Timestamp, 1=League, 2=Player, 3=Market, 4=Line,
  // 5=Direction, 6=Book, 7=BookOdds, 8=BookProb, 9=ConsensusProb, 10=Edge,
  // 11=Game, 12=PrizePicks, 13=Underdog, 14=Betr, 15=Sleepr,
  // (new cols) 16=WeightModifier, 17=StatusBump, 18=AdjustedEdge, 19=Confidence, 20=Units
  for (const row of combos.slice(1)) {
    snapRows.push([
      ts,
      row[1] || '',   // League
      row[2] || '',   // Player
      row[3] || '',   // Market
      row[4] || '',   // Line
      row[5] || '',   // Direction
      row[6] || '',   // Book
      row[7] || '',   // BookOdds
      row[8] || '',   // BookProb
      row[9] || '',   // ConsensusProb
      row[10] || '',  // Edge
      row[11] || '',  // Game
      row[18] || '',  // AdjustedEdge
      row[19] || '',  // Confidence
      row[20] || '',  // Units
    ]);
  }

  await clearSheet(SPREADSHEET_ID, SHEETS.PROP_CLV_OPENING);
  await setValues(SPREADSHEET_ID, SHEETS.PROP_CLV_OPENING, 'A1', snapRows);
  console.log(`[prop-clv] Snapshotted ${snapRows.length - 1} opening edges`);
}

/**
 * Grade prop edges against closing lines.
 * Called nightly (trigger12 expansion) after games finish.
 *
 * For each opening edge in Prop_CLV_Opening:
 * 1. Re-fetch the current prop lines for that event (these are now "closing" lines)
 * 2. Compare: did the book's implied probability move toward our edge?
 * 3. If closing prob > opening prob on our side → CLV hit (market confirmed our edge)
 * 4. Write results to Prop_Performance
 *
 * When the Odds API no longer has lines for completed events, we mark those
 * as "expired" and use the last available snapshot as closing.
 */
async function gradePropEdges() {
  console.log('[prop-clv] Grading prop edges against closing lines...');

  const openingSnap = await getValues(SPREADSHEET_ID, SHEETS.PROP_CLV_OPENING);
  if (!openingSnap || openingSnap.length < 2) {
    console.log('[prop-clv] No opening snapshot to grade.');
    return;
  }

  // Read current Player_Props as "closing" lines (fetched by trigger11 or trigger12)
  const closingProps = await getValues(SPREADSHEET_ID, SHEETS.PLAYER_PROPS);
  const closingIndex = {}; // "player|market|line|direction|book" → closing price
  if (closingProps && closingProps.length > 1) {
    for (const row of closingProps.slice(1)) {
      const player = row[3] || '';
      const direction = row[4] || '';
      const price = parseFloat(row[5]);
      const line = row[6] || '';
      const market = row[7] || '';
      const book = row[2] || '';
      if (!player || isNaN(price)) continue;
      const key = `${player}|${market}|${line}|${direction}|${book}`;
      closingIndex[key] = price;
    }
  }

  const impliedProb = (odds) => {
    const o = parseFloat(odds);
    if (isNaN(o) || o === 0) return 0.5;
    return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
  };

  // Grade each opening edge
  const perfRows = [];
  const ts = new Date().toISOString();
  let hits = 0, misses = 0, ungraded = 0;

  for (const row of openingSnap.slice(1)) {
    const league = row[1] || '';
    const player = row[2] || '';
    const market = row[3] || '';
    const line = row[4] || '';
    const direction = row[5] || '';
    const book = row[6] || '';
    const openingOdds = parseFloat(row[7]) || -110;
    const openingEdge = parseFloat(row[10]) || 0;
    const game = row[11] || '';
    const adjustedEdge = parseFloat(row[12]) || openingEdge;
    const confidence = row[13] || '';
    const units = row[14] || '';

    // Look up closing line
    const closingKey = `${player}|${market}|${line}|${direction}|${book}`;
    const closingOdds = closingIndex[closingKey];

    let clvGrade = 'UNGRADED';
    let closingEdge = '';

    if (closingOdds !== undefined) {
      const openProb = impliedProb(openingOdds);
      const closeProb = impliedProb(closingOdds);

      // CLV hit: closing line implies MORE probability on our side
      // (meaning the market moved our way, confirming our edge)
      if (direction === 'Over') {
        // Over bet: if closing over-prob > opening over-prob → CLV hit
        clvGrade = closeProb > openProb ? 'HIT' : 'MISS';
      } else {
        // Under bet: same logic (closing under-prob > opening under-prob)
        clvGrade = closeProb > openProb ? 'HIT' : 'MISS';
      }

      closingEdge = ((closeProb - openProb) * 100).toFixed(2);
      if (clvGrade === 'HIT') hits++;
      else misses++;
    } else {
      ungraded++;
    }

    perfRows.push([
      ts, league, player, market, line, direction, book,
      openingEdge, closingEdge, clvGrade, closingOdds || '',
      game, adjustedEdge, confidence, units,
    ]);
  }

  // Append to Prop_Performance (don't overwrite — accumulate history)
  const header = ['Timestamp', 'League', 'Player', 'Market', 'Line', 'Direction',
    'Book', 'OpeningEdge', 'ClosingEdge', 'CLVGrade', 'ClosingOdds',
    'Game', 'AdjustedEdge', 'Confidence', 'Units'];

  const existing = await getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE);
  if (!existing || existing.length === 0) {
    await setValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE, 'A1', [header, ...perfRows]);
  } else {
    const nextRow = existing.length + 1;
    await setValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE, `A${nextRow}`, perfRows);
  }

  console.log(`[prop-clv] Graded ${perfRows.length} edges: ${hits} CLV hits, ${misses} misses, ${ungraded} ungraded`);
  if (hits + misses > 0) {
    console.log(`[prop-clv] CLV hit rate: ${(hits / (hits + misses) * 100).toFixed(1)}%`);
  }
}

/**
 * Nightly weight auto-update. Reads Prop_Performance (last 7 days),
 * computes CLV metrics per league+market, and adjusts PropWeights.
 *
 * Called by trigger14 (11:30 PM, after gradePropEdges at 11:00 PM).
 */
async function updateAllPropWeights() {
  console.log('[prop-clv] Running nightly prop weight update...');

  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PROP_PERFORMANCE);
  if (!perfRows || perfRows.length < 2) {
    console.log('[prop-clv] No performance data yet — skipping weight update.');
    return;
  }

  // Filter to last 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Aggregate by league+market
  // Perf cols: 0=Timestamp, 1=League, 2=Player, 3=Market, ..., 9=CLVGrade
  const metrics = {}; // "league|market" → { hits, total }

  for (const row of perfRows.slice(1)) {
    const dateStr = String(row[0] || '').slice(0, 10);
    if (dateStr < cutoffStr) continue;

    const league = row[1] || '';
    const market = row[3] || '';
    const grade = row[9] || '';
    if (!league || !market || (grade !== 'HIT' && grade !== 'MISS')) continue;

    const key = `${league}|${market}`;
    if (!metrics[key]) metrics[key] = { hits: 0, total: 0 };
    metrics[key].total++;
    if (grade === 'HIT') metrics[key].hits++;
  }

  // Process each league
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    const currentWeights = await readPropWeights(league);
    const leagueMetrics = {};

    for (const [key, vals] of Object.entries(metrics)) {
      if (!key.startsWith(`${league}|`)) continue;
      const market = key.split('|')[1];
      leagueMetrics[market] = {
        hitRate: vals.total > 0 ? vals.hits / vals.total : 0.5,
        sampleSize: vals.total,
        avgEdge: 0, // TODO: compute from actual edge values
      };
    }

    if (Object.keys(leagueMetrics).length === 0) {
      console.log(`[prop-clv] ${league}: no graded data in last 7 days, skipping.`);
      continue;
    }

    const updates = computeWeightUpdates(currentWeights, leagueMetrics);
    await writePropWeights(league, updates);
    console.log(`[prop-clv] ${league}: updated ${Object.keys(updates).length} market weights`);
  }
}

module.exports = { snapPropLines, gradePropEdges, updateAllPropWeights };
