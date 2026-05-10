'use strict';
/**
 * scripts/backtest-sweep.js — Parameter sweep backtester
 *
 * Reads graded picks from Performance Log, extracts feature vectors from
 * prediction_features table (Supabase), and simulates 100+ parameter
 * combinations to find which would have performed best.
 *
 * Run: node scripts/backtest-sweep.js [--days 60] [--top 20]
 *
 * Output: ranked table of parameter combos by ROI, saved to
 * weight-reviews/sweep-results-YYYY-MM-DD.json
 */
require('dotenv').config();
const { getValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const db = require('../src/db');
const { extractFeatures } = require('../src/game-features');
const { scoreMarket, scoreToMarginAdj, scoreToTotalAdj } = require('../src/game-features');
const { getHistoricalTeamStats } = require('../src/snapshots');
const { americanToImpliedProb } = require('../src/market-pricing');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DAYS = parseInt(args.find((_, i, a) => a[i-1] === '--days') || '60');
const TOP_N = parseInt(args.find((_, i, a) => a[i-1] === '--top') || '20');

// ── Constants from game-model.js ────────────────────────────────
const STRENGTH_TO_MARGIN = { NBA: 40.0, NFL: 28.0, MLB: 8.0, NHL: 5.0 };
const AVG_TOTAL = { NBA: 226, NFL: 46, MLB: 8.8, NHL: 6.2 };

function projectMargin(homeStr, awayStr, league) {
  const diff = homeStr - awayStr;
  return diff * (STRENGTH_TO_MARGIN[league] || 20);
}

function projectWinProb(margin, league) {
  const scale = league === 'MLB' ? 8 : league === 'NHL' ? 5 : league === 'NFL' ? 14 : 12;
  return 1.0 / (1.0 + Math.pow(10, -margin / scale));
}

// ── Parameter combos to test ────────────────────────────────────
function generateCombos() {
  const combos = [];

  // Base: current production settings
  combos.push({ name: 'CURRENT', csvDampen: 0.30, edgeMultiplier: 0.05, minEdge: 0, confidencePower: null });

  // csvDampen variations
  for (const d of [0.10, 0.15, 0.20, 0.25, 0.35, 0.40, 0.50]) {
    combos.push({ name: `csvDampen_${d}`, csvDampen: d, edgeMultiplier: 0.05, minEdge: 0, confidencePower: null });
  }

  // edgeMultiplier variations (bet sizing aggressiveness)
  for (const e of [0.02, 0.03, 0.04, 0.06, 0.07, 0.08, 0.10]) {
    combos.push({ name: `edgeMult_${e}`, csvDampen: 0.30, edgeMultiplier: e, minEdge: 0, confidencePower: null });
  }

  // Minimum edge filter (only bet when edge > X%)
  for (const m of [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]) {
    combos.push({ name: `minEdge_${m}`, csvDampen: 0.30, edgeMultiplier: 0.05, minEdge: m, confidencePower: null });
  }

  // Confidence power (how edge maps to display confidence/sizing)
  for (const c of [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5]) {
    combos.push({ name: `confPower_${c}`, csvDampen: 0.30, edgeMultiplier: 0.05, minEdge: 0, confidencePower: c });
  }

  // Combined: lower csvDampen + tighter minEdge
  for (const d of [0.15, 0.20, 0.25]) {
    for (const m of [2.0, 3.0, 4.0]) {
      combos.push({ name: `csv${d}_minE${m}`, csvDampen: d, edgeMultiplier: 0.05, minEdge: m, confidencePower: null });
    }
  }

  // Combined: edgeMultiplier + minEdge
  for (const e of [0.03, 0.04]) {
    for (const m of [2.0, 3.0]) {
      combos.push({ name: `eMult${e}_minE${m}`, csvDampen: 0.30, edgeMultiplier: e, minEdge: m, confidencePower: null });
    }
  }

  // Combined: lower csv + lower edgeMult (conservative)
  for (const d of [0.15, 0.20]) {
    for (const e of [0.03, 0.04]) {
      combos.push({ name: `csv${d}_eMult${e}`, csvDampen: d, edgeMultiplier: e, minEdge: 0, confidencePower: null });
    }
  }

  // Ultra-conservative combos
  combos.push({ name: 'ultraConservative', csvDampen: 0.15, edgeMultiplier: 0.03, minEdge: 3.0, confidencePower: 2.0 });
  combos.push({ name: 'moderateConservative', csvDampen: 0.20, edgeMultiplier: 0.04, minEdge: 2.0, confidencePower: 1.6 });
  combos.push({ name: 'aggressiveGood', csvDampen: 0.40, edgeMultiplier: 0.06, minEdge: 2.5, confidencePower: 1.4 });

  // Weight scaling per market (multiply all weights for a market by factor)
  for (const factor of [0.5, 0.7, 0.8, 1.2, 1.5, 2.0]) {
    combos.push({ name: `mlScale_${factor}`, csvDampen: 0.30, edgeMultiplier: 0.05, minEdge: 0, confidencePower: null, marketScale: { moneyline: factor } });
    combos.push({ name: `spreadScale_${factor}`, csvDampen: 0.30, edgeMultiplier: 0.05, minEdge: 0, confidencePower: null, marketScale: { spread: factor } });
    combos.push({ name: `totalScale_${factor}`, csvDampen: 0.30, edgeMultiplier: 0.05, minEdge: 0, confidencePower: null, marketScale: { total: factor } });
  }

  return combos;
}

// ── Simulate a single pick under a given parameter set ──────────
function simulatePick(pick, combo) {
  const { features, market, odds, result, league, weights } = pick;
  if (!features || !weights) return null;

  const csvDampen = combo.csvDampen;
  const marketWeights = { ...(weights[market] || {}) };

  // Apply market scaling if specified
  if (combo.marketScale && combo.marketScale[market]) {
    const scale = combo.marketScale[market];
    for (const key of Object.keys(marketWeights)) {
      if (!key.startsWith('param_') && !key.startsWith('score_')) {
        marketWeights[key] = (marketWeights[key] || 0) * scale;
      }
    }
  }

  // Score with (possibly scaled) weights
  const score = scoreMarket(features, marketWeights);

  // Compute edge (simplified: score * csvDampen → margin adjustment → win prob → edge vs market)
  let modelProb;
  if (market === 'moneyline' || market === 'spread') {
    const marginAdj = scoreToMarginAdj(score, league) * csvDampen;
    // Base margin is implicit in features; we approximate by using the score directly
    modelProb = projectWinProb(marginAdj * 2, league); // rough scaling
  } else {
    // Totals: harder to simulate without full pipeline; use raw edge from pick
    modelProb = pick.rawModelProb || 0.52;
  }

  const impliedProb = pick.impliedProb || 0.50;
  const edge = (modelProb - impliedProb) * 100;

  // Apply minEdge filter
  if (edge < combo.minEdge) return { units: 0, result, skipped: true };

  // Calculate units
  let units = Math.max(0, edge) * combo.edgeMultiplier;
  units = Math.max(0.01, Math.min(0.50, units));

  // Calculate return
  let unitReturn = 0;
  if (result === 'W') {
    if (odds > 0) unitReturn = units * (odds / 100);
    else unitReturn = units * (100 / Math.abs(odds));
  } else if (result === 'L') {
    unitReturn = -units;
  }

  return { units, unitReturn, result, skipped: false, edge };
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Shadow Bets Parameter Sweep Backtest ===`);
  console.log(`Window: last ${DAYS} days | Reporting top ${TOP_N} combos\n`);

  // 1. Load Performance Log
  console.log('Loading Performance Log...');
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) {
    console.error('No performance data');
    process.exit(1);
  }

  // 2. Load current weight sheets
  console.log('Loading weight sheets...');
  const { readWeights, sheetForLeague } = require('../src/weights');
  const allWeights = {};
  for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
    allWeights[league] = await readWeights(sheetForLeague(league));
  }

  // 3. Load prediction_features from Supabase for feature vectors
  let featureMap = {};  // gameKey → features
  if (db.isEnabled()) {
    console.log('Loading prediction features from Supabase...');
    const sb = db.getClient();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DAYS);

    const { data, error } = await sb
      .from('prediction_features')
      .select('game_id, league, market, features, predicted_prob, edge')
      .gte('created_at', cutoffDate.toISOString());

    if (data && data.length > 0) {
      console.log(`  Loaded ${data.length} feature vectors from Supabase`);
      for (const row of data) {
        const key = `${row.game_id}|${row.market}`;
        featureMap[key] = {
          features: row.features,
          predicted_prob: row.predicted_prob,
          edge: row.edge,
        };
      }
    } else {
      console.log('  No Supabase features available, will use inline JSON from perf log');
    }
  }

  // 4. Parse graded picks with features
  console.log('Parsing graded picks...');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  const picks = [];
  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 18) continue;

    const result = (row[16] || '').toString().trim();
    if (result !== 'W' && result !== 'L') continue;

    const rawDate = String(row[0] || '').trim();
    const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!parts) continue;
    const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (pickDate < cutoff) continue;

    const league = (row[1] || '').trim().toUpperCase();
    const market = (row[2] || '').trim().toLowerCase();
    const oddsRaw = parseFloat(String(row[9] || '0').replace(/[^0-9.\-]/g, ''));
    const unitsRaw = parseFloat(String(row[10] || '0').replace(/[^0-9.\-]/g, ''));
    const edgeRaw = parseFloat(String(row[11] || '0').replace(/[^0-9.%\-]/g, ''));

    // Try to get features: first from Supabase featureMap, then from inline JSON
    let features = null;
    const gameTime = (row[5] || '').trim();
    const supaKey = `${gameTime}|${market}`;
    if (featureMap[supaKey]) {
      features = featureMap[supaKey].features;
    }

    // Fallback: try inline JSON in the row (column 18+)
    if (!features) {
      for (let c = 17; c < row.length; c++) {
        const cell = String(row[c] || '');
        if (cell.startsWith('{')) {
          try {
            features = JSON.parse(cell);
            break;
          } catch (e) { /* skip */ }
        }
      }
    }

    // Compute implied prob from odds
    let impliedProb = 0.50;
    if (oddsRaw !== 0) {
      if (oddsRaw > 0) impliedProb = 100 / (oddsRaw + 100);
      else impliedProb = Math.abs(oddsRaw) / (Math.abs(oddsRaw) + 100);
    }

    picks.push({
      date: pickDate,
      league,
      market,
      odds: oddsRaw,
      units: unitsRaw,
      edge: edgeRaw,
      result,
      features,
      impliedProb,
      rawModelProb: impliedProb + (edgeRaw / 100),
      weights: allWeights[league] || {},
    });
  }

  console.log(`Parsed ${picks.length} graded picks with results in last ${DAYS} days`);
  const withFeatures = picks.filter(p => p.features);
  console.log(`  ${withFeatures.length} have feature vectors for re-scoring`);
  const withoutFeatures = picks.filter(p => !p.features);
  console.log(`  ${withoutFeatures.length} missing features (will use recorded edge)\n`);

  if (picks.length < 50) {
    console.error('Not enough data for meaningful backtest (need 50+)');
    process.exit(1);
  }

  // 5. Generate parameter combos
  const combos = generateCombos();
  console.log(`Testing ${combos.length} parameter combinations...\n`);

  // 6. Run sweep
  const results = [];
  for (const combo of combos) {
    let totalReturn = 0;
    let totalWagered = 0;
    let wins = 0, losses = 0, skipped = 0;
    const leagueResults = {};

    for (const pick of picks) {
      let simResult;

      if (pick.features) {
        // Re-score with this combo's parameters
        simResult = simulatePick(pick, combo);
      } else {
        // No features: use recorded edge, apply combo's minEdge and edgeMultiplier
        const edge = pick.edge;
        if (edge < combo.minEdge) {
          simResult = { units: 0, result: pick.result, skipped: true };
        } else {
          let units = Math.max(0, edge) * combo.edgeMultiplier;
          units = Math.max(0.01, Math.min(0.50, units));
          let unitReturn = 0;
          if (pick.result === 'W') {
            if (pick.odds > 0) unitReturn = units * (pick.odds / 100);
            else unitReturn = units * (100 / Math.abs(pick.odds));
          } else {
            unitReturn = -units;
          }
          simResult = { units, unitReturn, result: pick.result, skipped: false, edge };
        }
      }

      if (!simResult) continue;

      if (simResult.skipped) {
        skipped++;
        continue;
      }

      totalReturn += simResult.unitReturn;
      totalWagered += simResult.units;
      if (simResult.result === 'W') wins++;
      else losses++;

      // Track per league
      const lKey = pick.league;
      if (!leagueResults[lKey]) leagueResults[lKey] = { ret: 0, w: 0, l: 0 };
      leagueResults[lKey].ret += simResult.unitReturn;
      if (simResult.result === 'W') leagueResults[lKey].w++;
      else leagueResults[lKey].l++;
    }

    const total = wins + losses;
    const winRate = total > 0 ? (wins / total * 100) : 0;
    const roi = totalWagered > 0 ? (totalReturn / totalWagered * 100) : 0;

    results.push({
      name: combo.name,
      params: combo,
      totalReturn: Math.round(totalReturn * 100) / 100,
      totalWagered: Math.round(totalWagered * 100) / 100,
      wins,
      losses,
      skipped,
      winRate: Math.round(winRate * 10) / 10,
      roi: Math.round(roi * 10) / 10,
      leagueResults,
    });
  }

  // 7. Sort by ROI (or totalReturn for absolute performance)
  results.sort((a, b) => b.totalReturn - a.totalReturn);

  // 8. Output
  console.log('='.repeat(100));
  console.log(`${'Rank'} | ${'Name'.padEnd(25)} | ${'W-L'.padEnd(9)} | ${'Win%'.padEnd(6)} | ${'Units Ret'.padEnd(10)} | ${'Wagered'.padEnd(8)} | ${'ROI%'.padEnd(7)} | Skipped`);
  console.log('-'.repeat(100));

  for (let i = 0; i < Math.min(TOP_N, results.length); i++) {
    const r = results[i];
    const record = `${r.wins}-${r.losses}`;
    console.log(
      `${String(i+1).padStart(4)} | ${r.name.padEnd(25)} | ${record.padEnd(9)} | ${String(r.winRate + '%').padEnd(6)} | ${String(r.totalReturn).padEnd(10)} | ${String(r.totalWagered).padEnd(8)} | ${String(r.roi + '%').padEnd(7)} | ${r.skipped}`
    );
  }

  // Also show current (baseline)
  const baseline = results.find(r => r.name === 'CURRENT');
  if (baseline) {
    const baseRank = results.indexOf(baseline) + 1;
    console.log('-'.repeat(100));
    console.log(`CURRENT PRODUCTION (rank #${baseRank}): ${baseline.wins}-${baseline.losses} | ${baseline.winRate}% | ${baseline.totalReturn} units | ROI ${baseline.roi}%`);
  }

  // Show bottom 5 (worst)
  console.log('\n--- WORST PERFORMERS ---');
  for (let i = results.length - 1; i >= Math.max(0, results.length - 5); i--) {
    const r = results[i];
    console.log(`  ${r.name}: ${r.wins}-${r.losses} | ${r.totalReturn} units | ROI ${r.roi}%`);
  }

  // 9. Save full results
  const outputDir = path.join(__dirname, '..', 'weight-reviews');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `sweep-results-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputFile, JSON.stringify({ 
    runDate: new Date().toISOString(),
    days: DAYS,
    totalPicks: picks.length,
    picksWithFeatures: withFeatures.length,
    combosTestedCount: combos.length,
    top20: results.slice(0, 20),
    baseline,
    allResults: results,
  }, null, 2));
  console.log(`\nFull results saved to: ${outputFile}`);

  // 10. Recommendations
  console.log('\n=== RECOMMENDATIONS ===');
  const top3 = results.slice(0, 3);
  for (const r of top3) {
    console.log(`\n${r.name}:`);
    console.log(`  ROI: ${r.roi}% | Units: ${r.totalReturn} | Win%: ${r.winRate}%`);
    console.log(`  Params: csvDampen=${r.params.csvDampen}, edgeMult=${r.params.edgeMultiplier}, minEdge=${r.params.minEdge}`);
    if (r.params.confidencePower) console.log(`  confidencePower=${r.params.confidencePower}`);
    if (r.params.marketScale) console.log(`  marketScale=${JSON.stringify(r.params.marketScale)}`);
    // League breakdown
    for (const [lg, lr] of Object.entries(r.leagueResults || {})) {
      const lWin = lr.w + lr.l > 0 ? (lr.w / (lr.w + lr.l) * 100).toFixed(1) : 0;
      console.log(`    ${lg}: ${lr.w}-${lr.l} (${lWin}%) → ${lr.ret.toFixed(2)} units`);
    }
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
