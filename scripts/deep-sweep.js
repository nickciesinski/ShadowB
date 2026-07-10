'use strict';
/**
 * scripts/deep-sweep.js — deep per-league weight exploration (REPORT-ONLY)
 *
 * Purpose: test a much larger space of weight configurations than the weekly
 * sweep (~150 structured combos shared across leagues) — thousands of random
 * configurations PER LEAGUE — while staying statistically honest about
 * overfitting. This script NEVER writes weights. It commits JSON reports for
 * human review; anything applied later goes through the normal conservative
 * path and the weekly promotion gate.
 *
 * Anti-overfitting protocol (the R0.1 lesson, formalized):
 *   - Expanding-window walk-forward folds: select on TRAIN, score on the
 *     TEST weeks after it, roll forward. Selection NEVER sees test data.
 *   - "Candidates" = configs that rank top-K on train in >=2 folds
 *     (stable in-sample performers, not one-fold flukes).
 *   - "Survivors" = candidates whose TEST lift is positive in >=2 folds
 *     AND positive on average.
 *   - The honesty metric: each fold's #1 train performer's test lift.
 *     If that's ~0 across folds (as R0.1 found), the sweep has no real
 *     signal at this data size and NOTHING should be applied, no matter
 *     how good the in-sample numbers look.
 *
 * Usage: node scripts/deep-sweep.js [--days 150] [--configs 1500] [--leagues MLB,NBA,NHL,NFL] [--seed 42]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dataStore = require('../src/data-store');
const db = require('../src/db');
const { scoreMarket } = require('../src/game-features');
const { calcUnits } = require('../src/market-pricing');
const { readWeights, sheetForLeague } = require('../src/weights');

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DAYS = parseInt(argVal('days', '150'));
const N_CONFIGS = parseInt(argVal('configs', '1500'));
const LEAGUES = argVal('leagues', 'MLB,NBA,NHL,NFL').split(',').map(s => s.trim().toUpperCase());
const SEED = parseInt(argVal('seed', '42'));

// Fold geometry
const TEST_DAYS = 21;          // each test window ~3 weeks
const N_FOLDS = 3;             // expanding-window folds
const MIN_TRAIN = 150;         // graded picks needed to trust a train fit
const MIN_TEST = 40;           // graded picks needed to trust a test read
const TOP_K = 25;              // train ranking cut for candidacy
const MAX_REPORT_CANDIDATES = 40;

// ── Seeded RNG (mulberry32) — reproducible random search ────────
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Pick loading (auto-apply-weights.js pattern, parameterized + paginated) ──
async function loadPicks(days) {
  const perfRows = await dataStore.read('performanceRows');
  if (!perfRows || perfRows.length < 2) throw new Error('No Performance Log data');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const picks = [];
  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row || row.length < 17) continue;
    const result = (row[16] || '').toString().trim();
    if (result !== 'W' && result !== 'L') continue;
    const rawDate = String(row[0] || '').trim();
    const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!parts) continue;
    const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (pickDate < cutoff) continue;

    const league = (row[1] || '').trim().toUpperCase();
    const market = (row[2] || '').trim().toLowerCase();
    const mappedMarket = market.includes('spread') ? 'spread' : market.includes('total') ? 'total' : 'moneyline';
    const odds = parseInt(String(row[9] || '-110').replace(/[^0-9.\-]/g, '')) || -110;
    const units = parseFloat(String(row[10] || '0').replace(/[^0-9.\-]/g, '')) || 0;
    const dateISO = `${parseInt(parts[3])}-${String(parseInt(parts[1])).padStart(2, '0')}-${String(parseInt(parts[2])).padStart(2, '0')}`;

    picks.push({
      date: rawDate, dateISO, league, market: mappedMarket,
      game: (row[3] || '').toString(), actualResult: result, odds, units, features: null,
    });
  }

  // Attach features from Supabase prediction_features (paginated — the weekly
  // script's flat .limit(5000) can truncate long windows)
  if (db.isEnabled()) {
    const sb = db.getClient();
    const featureMap = {};
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sb.from('prediction_features')
        .select('date, league, market, home_team, away_team, features, edge, predicted_prob, final_units, disagreement, data_completeness')
        .gte('date', cutoff.toISOString().slice(0, 10))
        .order('date', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) { console.warn('[deep-sweep] feature page failed:', error.message); break; }
      if (!data || data.length === 0) break;
      for (const row of data) {
        if (!row.features || typeof row.features !== 'object') continue;
        const key = `${row.date}|${row.league}|${row.market}`;
        if (!featureMap[key]) featureMap[key] = [];
        featureMap[key].push({
          features: row.features, home: row.home_team, away: row.away_team,
          origEdge: row.edge || 0, predictedProb: row.predicted_prob || null,
          origUnits: row.final_units || 0, dataCompleteness: row.data_completeness || 0,
        });
      }
      if (data.length < PAGE) break;
    }

    let matched = 0;
    for (const p of picks) {
      const key = `${p.dateISO}|${p.league}|${p.market}`;
      const rows = featureMap[key];
      if (!rows) continue;
      const hit = rows.find(r => p.game && (String(p.game).includes(String(r.away)) || String(r.away || '').includes(String(p.game)))) || rows[0];
      if (hit) {
        p.features = hit.features; p.origEdge = hit.origEdge;
        p.origUnits = hit.origUnits; p.dataCompleteness = hit.dataCompleteness;
        matched++;
      }
    }
    console.log(`[deep-sweep] ${picks.length} graded picks in ${days}d; features matched: ${matched}`);
  }
  return picks;
}

// ── Weight modification + simulation (single-league) ────────────
function modifyWeights(baseWeights, mods) {
  const w = JSON.parse(JSON.stringify(baseWeights));
  for (const mod of mods) {
    const markets = mod.market === 'all' ? ['moneyline', 'spread', 'total'] : [mod.market];
    for (const m of markets) {
      if (!w[m]) continue;
      if (mod.action === 'zero') { if (w[m][mod.key] !== undefined) w[m][mod.key] = 0; }
      else if (mod.action === 'multiply') { if (w[m][mod.key] !== undefined) w[m][mod.key] *= mod.value; }
    }
  }
  return w;
}

/**
 * Simulate one league's picks under (optionally modified) weights.
 * Mirrors auto-apply-weights.js simulate(): sign-flip detection + edge
 * rescaling + unit re-pricing. Precomputed base scores are passed in so the
 * baseline isn't recomputed for every config.
 */
function simulateLeague(picks, modW, baseScores) {
  let wins = 0, losses = 0, totalReturn = 0, totalRisked = 0;
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const baseScore = baseScores[i];
    const modScore = scoreMarket(pick.features, modW[pick.market] || {});

    let wouldWin;
    if (baseScore !== 0 && Math.sign(modScore) !== Math.sign(baseScore)) {
      wouldWin = pick.actualResult === 'L';
    } else {
      wouldWin = pick.actualResult === 'W';
    }

    const origEdge = pick.origEdge || 0;
    let newEdge = origEdge;
    if (origEdge > 0 && baseScore !== 0) {
      const ratio = Math.abs(modScore) / Math.abs(baseScore);
      newEdge = Math.abs(origEdge) * ratio;
    }
    const uncertainty = pick.dataCompleteness != null ? 1 - Math.min(1, pick.dataCompleteness) : 0.5;
    const units = calcUnits(Math.max(0, newEdge), uncertainty, 0.7, 1.0, 1.0);

    totalRisked += units;
    if (wouldWin) {
      wins++;
      totalReturn += pick.odds > 0 ? units * (pick.odds / 100) : units * (100 / Math.abs(pick.odds));
    } else {
      losses++; totalReturn -= units;
    }
  }
  const total = wins + losses;
  return {
    wins, losses,
    winRate: total ? parseFloat((wins / total * 100).toFixed(1)) : 0,
    roi: totalRisked ? parseFloat((totalReturn / totalRisked * 100).toFixed(1)) : 0,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    totalRisked: parseFloat(totalRisked.toFixed(2)),
  };
}

// ── Config generation ────────────────────────────────────────────
function weightKeys(leagueWeights) {
  const keys = new Set();
  for (const m of ['moneyline', 'spread', 'total']) {
    for (const k of Object.keys(leagueWeights[m] || {})) {
      if (!k.startsWith('sp_') && !k.startsWith('param_') && !k.startsWith('score_')) keys.add(k);
    }
  }
  return [...keys];
}

function buildConfigs(leagueWeights, nRandom, rand) {
  const keys = weightKeys(leagueWeights);
  const configs = [];

  // Structured single-key probes (interpretability anchors)
  for (const key of keys) {
    configs.push({ name: `zero_${key}`, mods: [{ market: 'all', key, action: 'zero' }] });
    configs.push({ name: `2x_${key}`, mods: [{ market: 'all', key, action: 'multiply', value: 2 }] });
    configs.push({ name: `0.5x_${key}`, mods: [{ market: 'all', key, action: 'multiply', value: 0.5 }] });
  }

  // Random search: each config perturbs a random subset of keys with
  // log-uniform multipliers in [0.4, 2.5]; ~5% chance a chosen key is zeroed.
  for (let i = 0; i < nRandom; i++) {
    const mods = [];
    for (const key of keys) {
      if (rand() < 0.6) continue; // leave most keys at baseline each draw
      if (rand() < 0.05) {
        mods.push({ market: 'all', key, action: 'zero' });
      } else {
        const value = parseFloat(Math.exp(Math.log(0.4) + rand() * (Math.log(2.5) - Math.log(0.4))).toFixed(3));
        mods.push({ market: 'all', key, action: 'multiply', value });
      }
    }
    if (mods.length === 0) { i--; continue; }
    configs.push({ name: `rand_${i}`, mods });
  }
  return configs;
}

// ── Fold construction (expanding window) ─────────────────────────
function buildFolds(picks, nFolds, testDays) {
  const sorted = [...picks].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  if (sorted.length === 0) return [];
  const lastDate = new Date(sorted[sorted.length - 1].dateISO);
  const folds = [];
  for (let f = nFolds; f >= 1; f--) {
    const testEnd = new Date(lastDate); testEnd.setDate(testEnd.getDate() - (f - 1) * testDays);
    const testStart = new Date(testEnd); testStart.setDate(testStart.getDate() - testDays);
    const tEndISO = testEnd.toISOString().slice(0, 10);
    const tStartISO = testStart.toISOString().slice(0, 10);
    const train = sorted.filter(p => p.dateISO < tStartISO);
    const test = sorted.filter(p => p.dateISO >= tStartISO && p.dateISO <= tEndISO);
    folds.push({ idx: nFolds - f + 1, trainRange: [sorted[0].dateISO, tStartISO], testRange: [tStartISO, tEndISO], train, test });
  }
  return folds;
}

// ── Per-league deep sweep ────────────────────────────────────────
function sweepLeague(league, picks, leagueWeights, nConfigs, rand) {
  const withFeatures = picks.filter(p => p.features && Object.keys(p.features).length > 3);
  const report = { league, gradedPicks: picks.length, withFeatures: withFeatures.length, folds: [], candidates: [], survivors: [], honesty: {}, notes: [] };

  if (withFeatures.length < MIN_TRAIN + MIN_TEST) {
    report.notes.push(`Insufficient feature-backed picks (${withFeatures.length} < ${MIN_TRAIN + MIN_TEST}) — league skipped. Result-replay can't test weight changes.`);
    return report;
  }

  const weightsWrap = leagueWeights; // { moneyline, spread, total, params }
  const configs = buildConfigs(weightsWrap, nConfigs, rand);
  report.configsTested = configs.length;

  const folds = buildFolds(withFeatures, N_FOLDS, TEST_DAYS)
    .filter(f => f.train.length >= MIN_TRAIN && f.test.length >= MIN_TEST);
  if (folds.length < 2) {
    report.notes.push(`Only ${folds.length} usable folds (need >=2) — data too short/thin for walk-forward at this geometry.`);
    return report;
  }

  // Precompute base scores per fold subset
  const perFold = [];
  for (const fold of folds) {
    const baseTrainScores = fold.train.map(p => scoreMarket(p.features, weightsWrap[p.market] || {}));
    const baseTestScores = fold.test.map(p => scoreMarket(p.features, weightsWrap[p.market] || {}));
    const baselineTrain = simulateLeague(fold.train, weightsWrap, baseTrainScores);
    const baselineTest = simulateLeague(fold.test, weightsWrap, baseTestScores);

    // Evaluate every config on train and test
    const rows = [];
    for (const c of configs) {
      const modW = modifyWeights(weightsWrap, c.mods);
      const tr = simulateLeague(fold.train, modW, baseTrainScores);
      const te = simulateLeague(fold.test, modW, baseTestScores);
      rows.push({
        name: c.name,
        trainRoiLift: parseFloat((tr.roi - baselineTrain.roi).toFixed(1)),
        trainWinLift: parseFloat((tr.winRate - baselineTrain.winRate).toFixed(1)),
        testRoiLift: parseFloat((te.roi - baselineTest.roi).toFixed(1)),
        testWinLift: parseFloat((te.winRate - baselineTest.winRate).toFixed(1)),
      });
    }
    // Train ranking (selection NEVER touches test columns)
    rows.sort((a, b) => b.trainWinLift - a.trainWinLift || b.trainRoiLift - a.trainRoiLift);
    rows.forEach((r, i) => { r.trainRank = i + 1; });

    const trainWinner = rows[0];
    perFold.push({ fold, baselineTrain, baselineTest, rows, trainWinner });
    report.folds.push({
      idx: fold.idx,
      trainN: fold.train.length, testN: fold.test.length,
      trainRange: fold.trainRange, testRange: fold.testRange,
      baselineTrain: { winRate: baselineTrain.winRate, roi: baselineTrain.roi },
      baselineTest: { winRate: baselineTest.winRate, roi: baselineTest.roi },
      trainWinner: { name: trainWinner.name, trainRoiLift: trainWinner.trainRoiLift, trainWinLift: trainWinner.trainWinLift, testRoiLift: trainWinner.testRoiLift, testWinLift: trainWinner.testWinLift },
    });
  }

  // Honesty metric: mean test lift of each fold's #1 train performer
  const hw = perFold.map(pf => pf.trainWinner);
  report.honesty = {
    meanTrainWinnerTestRoiLift: parseFloat((hw.reduce((s, r) => s + r.testRoiLift, 0) / hw.length).toFixed(1)),
    meanTrainWinnerTestWinLift: parseFloat((hw.reduce((s, r) => s + r.testWinLift, 0) / hw.length).toFixed(1)),
    interpretation: 'If ~0 or negative, selecting on in-sample performance does not generalize at this data size — apply nothing.',
  };

  // Candidates: top-K on train in >= 2 folds
  const rankCount = new Map();
  for (const pf of perFold) {
    for (const r of pf.rows.slice(0, TOP_K)) {
      rankCount.set(r.name, (rankCount.get(r.name) || 0) + 1);
    }
  }
  const candidateNames = [...rankCount.entries()].filter(([, n]) => n >= 2).map(([name]) => name);
  const configByName = new Map(configs.map(c => [c.name, c]));

  for (const name of candidateNames) {
    const entries = perFold.map(pf => {
      const r = pf.rows.find(x => x.name === name);
      return { fold: pf.fold.idx, trainRank: r.trainRank, trainRoiLift: r.trainRoiLift, testRoiLift: r.testRoiLift, testWinLift: r.testWinLift };
    });
    const posTestFolds = entries.filter(e => e.testRoiLift > 0).length;
    const meanTestRoiLift = parseFloat((entries.reduce((s, e) => s + e.testRoiLift, 0) / entries.length).toFixed(1));
    const meanTestWinLift = parseFloat((entries.reduce((s, e) => s + e.testWinLift, 0) / entries.length).toFixed(1));
    const cand = { name, topKFolds: rankCount.get(name), posTestFolds, meanTestRoiLift, meanTestWinLift, perFold: entries, mods: configByName.get(name).mods };
    report.candidates.push(cand);
    if (posTestFolds >= 2 && meanTestRoiLift > 0) report.survivors.push(cand);
  }

  report.candidates.sort((a, b) => b.meanTestRoiLift - a.meanTestRoiLift);
  report.candidates = report.candidates.slice(0, MAX_REPORT_CANDIDATES);
  report.survivors.sort((a, b) => b.meanTestRoiLift - a.meanTestRoiLift);
  report.notes.push(`${candidateNames.length} stable train candidates of ${configs.length} configs; ${report.survivors.length} survived out-of-sample.`);
  return report;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== DEEP SWEEP (report-only) ===`);
  console.log(`Days: ${DAYS} | Random configs/league: ${N_CONFIGS} | Leagues: ${LEAGUES.join(',')} | Seed: ${SEED}`);
  console.log(`Folds: ${N_FOLDS} expanding, ${TEST_DAYS}d test windows | Candidacy: top-${TOP_K} train in >=2 folds`);

  const allPicks = await loadPicks(DAYS);
  const rand = mulberry32(SEED);

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, '..', 'weight-reviews', `deep-sweep-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const summary = { date: stamp, days: DAYS, configs: N_CONFIGS, seed: SEED, leagues: {} };

  for (const league of LEAGUES) {
    console.log(`\n── ${league} ──`);
    const picks = allPicks.filter(p => p.league === league);
    let weights;
    try { weights = await readWeights(sheetForLeague(league)); }
    catch (e) { console.warn(`  weights load failed: ${e.message}`); continue; }

    const t0 = Date.now();
    const report = sweepLeague(league, picks, weights, N_CONFIGS, rand);
    console.log(`  ${report.gradedPicks} graded / ${report.withFeatures} with features | folds: ${report.folds.length} | candidates: ${report.candidates.length} | survivors: ${report.survivors.length} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (report.honesty.meanTrainWinnerTestRoiLift !== undefined) {
      console.log(`  Honesty metric (train-winner test ROI lift): ${report.honesty.meanTrainWinnerTestRoiLift}`);
    }
    for (const n of report.notes) console.log(`  NOTE: ${n}`);

    fs.writeFileSync(path.join(outDir, `${league}.json`), JSON.stringify(report, null, 2));
    summary.leagues[league] = {
      gradedPicks: report.gradedPicks, withFeatures: report.withFeatures,
      folds: report.folds.length, candidates: report.candidates.length,
      survivors: report.survivors.slice(0, 5).map(s => ({ name: s.name, meanTestRoiLift: s.meanTestRoiLift, meanTestWinLift: s.meanTestWinLift, posTestFolds: s.posTestFolds })),
      honesty: report.honesty, notes: report.notes,
    };
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nReports written to ${outDir} — commit them via the workflow. NO weights were modified.`);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
}

module.exports = { buildFolds, buildConfigs, sweepLeague, simulateLeague, modifyWeights, weightKeys, mulberry32 };
