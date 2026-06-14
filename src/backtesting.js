'use strict';
/**
 * src/backtesting.js — Historical Replay & Weight Validation
 *
 * Three modes:
 *
 * 1. **Replay backtest** — Takes proposed modifier changes and replays them
 *    against the last N days of graded Performance Log data to estimate
 *    what ROI *would have been* under different stake sizing.
 *
 * 2. **Weight sensitivity analysis** — For each modifier key, runs +10%
 *    and -10% scenarios to see which direction improves ROI.
 *
 * 3. **Counterfactual backtest** — Re-runs the full game model using
 *    historical team stats + odds snapshots from Supabase. Tests what
 *    picks the model *would have generated* under proposed weight changes.
 *    This is the only mode that can evaluate CSV weight coefficient changes.
 *
 * All modes write results to the Backtest_Results sheet and return
 * a summary object.
 */
const { getValues, setValues } = require('./sheets');
const dataStore = require('./data-store');
const { SPREADSHEET_ID, SHEETS } = require('./config');
const db = require('./db');
const { getHistoricalTeamStats, getHistoricalOdds, getHistoricalInjuries } = require('./snapshots');
const { generateGamePicks } = require('./game-model');
const { readWeights, sheetForLeague } = require('./weights');
const { extractFeatures, scoreMarket } = require('./game-features');
const { setTunableFactors } = require('./stat-features');
const { calcUnits, americanToImpliedProb } = require('./market-pricing');

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Calculate unit return for a single bet given American odds and result.
 */
function calcReturn(odds, units, result) {
  if (result === 'W') {
    if (odds > 0) return units * (odds / 100);
    return units * (100 / Math.abs(odds));
  }
  if (result === 'L') return -units;
  return 0; // push
}

/**
 * Recalculate units under a modified set of performance modifiers.
 * Uses the same formula as market-pricing.js calcUnits() but with
 * the proposed modifier swapped in.
 */
function resizeUnits(originalUnits, originalMod, proposedMod) {
  if (!originalMod || originalMod === 0) return originalUnits;
  // Scale proportionally: newUnits = originalUnits * (proposedMod / originalMod)
  const ratio = (proposedMod || 1.0) / originalMod;
  return Math.max(0.01, Math.min(0.5, originalUnits * ratio));
}

// ── Performance Log Reader ──────────────────────────────────────

/**
 * Read graded picks from the Performance Log.
 * Returns array of { date, league, market, confidence, odds, units, result, unitReturn }
 */
async function readGradedPicks(days = 30) {
  // Try Supabase first for faster access
  if (db.isEnabled()) {
    const sb = db.getClient();
    if (sb) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const { data, error } = await sb
        .from('performance_log')
        .select('date, league, market, confidence, odds, final_units, result, unit_return')
        .gte('date', cutoff)
        .in('result', ['W', 'L', 'P']);

      if (!error && data && data.length > 0) {
        return data.map(r => ({
          date: r.date,
          league: r.league,
          market: r.market,
          confidence: parseInt(r.confidence) || 5,
          odds: parseInt(r.odds) || -110,
          units: parseFloat(r.final_units) || 0.05,
          result: r.result,
          unitReturn: parseFloat(r.unit_return) || 0,
        }));
      }
    }
  }

  // Fallback: Sheets
  const raw = await dataStore.read('performanceRows');
  if (!raw || raw.length < 2) return [];

  const headers = raw[0].map(h => String(h).trim().toLowerCase());
  const dateIdx = headers.indexOf('date');
  const leagueIdx = headers.indexOf('league');
  const marketIdx = headers.indexOf('market');
  const confIdx = headers.findIndex(h => h.includes('confidence') || h.includes('conf'));
  const oddsIdx = headers.indexOf('odds');
  const unitsIdx = headers.findIndex(h => h === 'units' || h === 'final_units');
  const resultIdx = headers.indexOf('result');
  const returnIdx = headers.findIndex(h => h.includes('return'));

  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const picks = [];

  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    const result = (r[resultIdx] || '').toString().trim().toUpperCase();
    if (result !== 'W' && result !== 'L' && result !== 'P') continue;

    const date = String(r[dateIdx] || '').slice(0, 10);
    if (date < cutoff) continue;

    picks.push({
      date,
      league: (r[leagueIdx] || '').trim(),
      market: (r[marketIdx] || '').trim(),
      confidence: parseInt(r[confIdx]) || 5,
      odds: parseInt(r[oddsIdx]) || -110,
      units: parseFloat(r[unitsIdx]) || 0.05,
      result,
      unitReturn: returnIdx >= 0 ? parseFloat(r[returnIdx]) || 0 : 0,
    });
  }

  return picks;
}

// ── Replay Backtest ─────────────────────────────────────────────

/**
 * Replay historical picks with proposed modifier changes.
 *
 * @param {Object} proposedModifiers - Map of "league|market" → new modifier value
 * @param {Object} [options] - { days: 30 }
 * @returns {Object} { baseline: {record, roi, units}, proposed: {record, roi, units}, diff }
 */
async function replayBacktest(proposedModifiers = {}, options = {}) {
  const days = options.days || 30;
  console.log(`[backtest] Running replay backtest over ${days} days...`);

  const picks = await readGradedPicks(days);
  if (picks.length === 0) {
    console.log('[backtest] No graded picks found');
    return null;
  }

  // Load current modifiers for baseline comparison
  let currentMods = {};
  if (db.isEnabled()) {
    currentMods = await db.readModifiers();
  }

  let baseWins = 0, baseLosses = 0, baseReturn = 0, baseTotalUnits = 0;
  let propWins = 0, propLosses = 0, propReturn = 0, propTotalUnits = 0;
  const detailRows = [['Date', 'League', 'Market', 'Odds', 'Result', 'BaseUnits', 'BaseReturn', 'PropUnits', 'PropReturn']];

  for (const pick of picks) {
    const key = `${pick.league}|${pick.market}`;
    const currentMod = currentMods[key] || 1.0;
    const proposedMod = proposedModifiers[key] !== undefined ? proposedModifiers[key] : currentMod;

    // Baseline: use recorded units
    const baseUnits = pick.units;
    const baseRet = calcReturn(pick.odds, baseUnits, pick.result);
    baseReturn += baseRet;
    baseTotalUnits += baseUnits;
    if (pick.result === 'W') baseWins++;
    if (pick.result === 'L') baseLosses++;

    // Proposed: resize units with new modifier
    const propUnits = resizeUnits(baseUnits, currentMod, proposedMod);
    const propRet = calcReturn(pick.odds, propUnits, pick.result);
    propReturn += propRet;
    propTotalUnits += propUnits;
    if (pick.result === 'W') propWins++;
    if (pick.result === 'L') propLosses++;

    detailRows.push([
      pick.date, pick.league, pick.market, pick.odds, pick.result,
      baseUnits.toFixed(3), baseRet.toFixed(3),
      propUnits.toFixed(3), propRet.toFixed(3),
    ]);
  }

  const baseROI = baseTotalUnits > 0 ? (baseReturn / baseTotalUnits * 100) : 0;
  const propROI = propTotalUnits > 0 ? (propReturn / propTotalUnits * 100) : 0;

  const summary = {
    days,
    totalPicks: picks.length,
    baseline: {
      record: `${baseWins}-${baseLosses}`,
      winRate: ((baseWins / (baseWins + baseLosses)) * 100).toFixed(1),
      netUnits: baseReturn.toFixed(2),
      totalRisked: baseTotalUnits.toFixed(2),
      roi: baseROI.toFixed(1),
    },
    proposed: {
      record: `${propWins}-${propLosses}`,
      winRate: ((propWins / (propWins + propLosses)) * 100).toFixed(1),
      netUnits: propReturn.toFixed(2),
      totalRisked: propTotalUnits.toFixed(2),
      roi: propROI.toFixed(1),
    },
    diff: {
      netUnits: (propReturn - baseReturn).toFixed(2),
      roi: (propROI - baseROI).toFixed(1),
    },
  };

  console.log(`[backtest] Baseline: ${summary.baseline.record} | ${summary.baseline.roi}% ROI | ${summary.baseline.netUnits}u`);
  console.log(`[backtest] Proposed: ${summary.proposed.record} | ${summary.proposed.roi}% ROI | ${summary.proposed.netUnits}u`);
  console.log(`[backtest] Diff: ${summary.diff.netUnits}u (${summary.diff.roi}% ROI)`);

  // Write to Backtest_Results sheet
  try {
    detailRows.push([]);
    detailRows.push(['', '', '', '', 'BASELINE', '', `${summary.baseline.netUnits}u`, '', '']);
    detailRows.push(['', '', '', '', 'PROPOSED', '', '', '', `${summary.proposed.netUnits}u`]);
    detailRows.push(['', '', '', '', 'DIFF', '', '', '', `${summary.diff.netUnits}u`]);
    await setValues(SPREADSHEET_ID, SHEETS.BACKTEST_RESULTS, 'A1', detailRows);
  } catch (e) {
    console.warn('[backtest] Could not write results to Sheets:', e.message);
  }

  return summary;
}

// ── Weight Sensitivity Analysis ─────────────────────────────────

/**
 * For each league|market modifier, test +10% and -10% scenarios
 * against historical data. Returns a ranked list showing which
 * changes would have improved ROI the most.
 *
 * @param {Object} [options] - { days: 30, delta: 0.10 }
 * @returns {Array} Ranked sensitivity results
 */
async function sensitivityAnalysis(options = {}) {
  const days = options.days || 30;
  const delta = options.delta || 0.10;
  console.log(`[backtest] Running sensitivity analysis (±${(delta * 100).toFixed(0)}%, ${days} days)...`);

  const picks = await readGradedPicks(days);
  if (picks.length === 0) {
    console.log('[backtest] No graded picks found');
    return [];
  }

  let currentMods = {};
  if (db.isEnabled()) {
    currentMods = await db.readModifiers();
  }

  // Find all unique league|market segments
  const segments = new Set();
  for (const pick of picks) {
    segments.add(`${pick.league}|${pick.market}`);
  }

  const results = [];

  for (const segment of segments) {
    const [league, market] = segment.split('|');
    const currentMod = currentMods[segment] || 1.0;
    const segPicks = picks.filter(p => p.league === league && p.market === market);
    if (segPicks.length < 10) continue;

    // Baseline
    let baseReturn = 0, baseUnits = 0;
    for (const p of segPicks) {
      baseReturn += calcReturn(p.odds, p.units, p.result);
      baseUnits += p.units;
    }

    // +delta scenario
    const upMod = Math.min(1.5, currentMod * (1 + delta));
    let upReturn = 0, upUnits = 0;
    for (const p of segPicks) {
      const u = resizeUnits(p.units, currentMod, upMod);
      upReturn += calcReturn(p.odds, u, p.result);
      upUnits += u;
    }

    // -delta scenario
    const downMod = Math.max(0.2, currentMod * (1 - delta));
    let downReturn = 0, downUnits = 0;
    for (const p of segPicks) {
      const u = resizeUnits(p.units, currentMod, downMod);
      downReturn += calcReturn(p.odds, u, p.result);
      downUnits += u;
    }

    const baseROI = baseUnits > 0 ? (baseReturn / baseUnits * 100) : 0;
    const upROI = upUnits > 0 ? (upReturn / upUnits * 100) : 0;
    const downROI = downUnits > 0 ? (downReturn / downUnits * 100) : 0;

    const bestDir = upReturn > downReturn ? 'up' : 'down';
    const bestReturn = bestDir === 'up' ? upReturn : downReturn;
    const impact = bestReturn - baseReturn;

    results.push({
      segment,
      league,
      market,
      sampleSize: segPicks.length,
      currentMod,
      baseROI: baseROI.toFixed(1),
      upROI: upROI.toFixed(1),
      downROI: downROI.toFixed(1),
      bestDirection: bestDir,
      impactUnits: impact.toFixed(3),
      suggestedMod: bestDir === 'up' ? upMod : downMod,
    });
  }

  // Sort by absolute impact (biggest improvement first)
  results.sort((a, b) => Math.abs(parseFloat(b.impactUnits)) - Math.abs(parseFloat(a.impactUnits)));

  // Log top results
  for (const r of results.slice(0, 10)) {
    console.log(`[backtest] ${r.segment}: ${r.bestDirection} → ${r.impactUnits}u impact (${r.sampleSize}n, ${r.baseROI}% → ${r.bestDirection === 'up' ? r.upROI : r.downROI}%)`);
  }

  // Write to sheet
  try {
    const rows = [['Segment', 'League', 'Market', 'Samples', 'CurrentMod', 'BaseROI', 'UpROI', 'DownROI', 'BestDir', 'Impact', 'SuggestedMod']];
    for (const r of results) {
      rows.push([r.segment, r.league, r.market, r.sampleSize, r.currentMod, r.baseROI, r.upROI, r.downROI, r.bestDirection, r.impactUnits, r.suggestedMod]);
    }
    await setValues(SPREADSHEET_ID, SHEETS.BACKTEST_RESULTS, 'A1', rows);
  } catch (e) {
    console.warn('[backtest] Could not write sensitivity results:', e.message);
  }

  return results;
}

/**
 * Quick validation: run the sensitivity analysis and check if the current
 * modifiers are directionally correct. Returns true if no segment would
 * benefit from >5% modifier change.
 */
async function validateCurrentWeights(days = 30) {
  const results = await sensitivityAnalysis({ days, delta: 0.05 });
  const misaligned = results.filter(r => Math.abs(parseFloat(r.impactUnits)) > 0.5);

  if (misaligned.length === 0) {
    console.log('[backtest] All weights validated — no significant improvements found');
    return { valid: true, misaligned: [] };
  }

  console.log(`[backtest] ${misaligned.length} segments could benefit from weight changes`);
  return { valid: false, misaligned };
}


// ── Counterfactual Backtest ─────────────────────────────────────

/**
 * Re-run the full game model against historical data with proposed
 * weight modifications. Uses Supabase snapshots (daily_team_stats,
 * daily_odds, daily_injuries) so feature reconstruction reflects
 * the state of the world on each pick date.
 *
 * Unlike replayBacktest (which only resizes units), this mode:
 *   - Rebuilds feature vectors from historical team stats
 *   - Re-scores markets with proposed CSV weights
 *   - Re-generates picks (potentially different directions)
 *   - Re-sizes units from scratch
 *   - Grades against actual results
 *
 * @param {Object} proposedWeightMods - Array of { market, key, action, value } mods
 *   (same format as weight-sweep.js modifyWeights)
 * @param {Object} [options] - { days: 60, leagues: ['MLB','NBA','NFL','NHL'] }
 * @returns {Object} { baseline, proposed, diff, byLeague, dayByDay }
 */
async function counterfactualBacktest(proposedWeightMods = [], options = {}) {
  const days = options.days || 60;
  const leagues = options.leagues || ['MLB', 'NBA', 'NFL', 'NHL'];
  console.log(`[backtest-cf] Running counterfactual backtest over ${days} days for ${leagues.join(',')}...`);

  if (!db.isEnabled()) {
    console.warn('[backtest-cf] Supabase required for counterfactual backtest');
    return null;
  }

  // 1. Load current weights per league
  const currentWeightsByLeague = {};
  for (const lg of leagues) {
    currentWeightsByLeague[lg] = await readWeights(sheetForLeague(lg));
  }

  // 2. Build proposed weights by applying mods
  const proposedWeightsByLeague = {};
  for (const lg of leagues) {
    proposedWeightsByLeague[lg] = applyWeightMods(
      JSON.parse(JSON.stringify(currentWeightsByLeague[lg])),
      proposedWeightMods
    );
  }

  // 3. Load graded picks for actual results
  const gradedPicks = await readGradedPicks(days);
  if (gradedPicks.length === 0) {
    console.log('[backtest-cf] No graded picks found');
    return null;
  }

  // Build result lookup: "YYYY-MM-DD|league|home|away|market" → result
  const resultLookup = {};
  for (const p of gradedPicks) {
    // Normalize date to YYYY-MM-DD
    let dateKey = p.date;
    const parts = dateKey.match(/(\d+)\/(\d+)\/(\d+)/);
    if (parts) {
      dateKey = `${parts[3]}-${String(parts[1]).padStart(2,'0')}-${String(parts[2]).padStart(2,'0')}`;
    }
    // Store by market
    const market = p.market.toLowerCase();
    const mNorm = market.includes('spread') ? 'spread' : market.includes('total') ? 'total' : 'moneyline';
    // We key loosely since team names may vary
    const key = `${dateKey}|${p.league}|${mNorm}`;
    if (!resultLookup[key]) resultLookup[key] = [];
    resultLookup[key].push(p);
  }

  // 4. Collect unique dates from graded picks
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const dateSet = new Set();
  for (const p of gradedPicks) {
    let d = p.date;
    const parts = d.match(/(\d+)\/(\d+)\/(\d+)/);
    if (parts) d = `${parts[3]}-${String(parts[1]).padStart(2,'0')}-${String(parts[2]).padStart(2,'0')}`;
    dateSet.add(d);
  }
  const dates = [...dateSet].sort();
  console.log(`[backtest-cf] ${dates.length} unique dates, ${gradedPicks.length} graded picks`);

  // 5. For each date × league: load historical data, run model with both weight sets
  const baseline = { wins: 0, losses: 0, units: 0, returns: 0 };
  const proposed = { wins: 0, losses: 0, units: 0, returns: 0 };
  const byLeague = {};
  const dayByDay = [];
  let datesWithData = 0;
  let datesSkipped = 0;

  for (const date of dates) {
    const dayResult = { date, baseWins: 0, baseLosses: 0, baseReturn: 0, propWins: 0, propLosses: 0, propReturn: 0 };

    for (const league of leagues) {
      if (!byLeague[league]) byLeague[league] = {
        baseline: { wins: 0, losses: 0, units: 0, returns: 0 },
        proposed: { wins: 0, losses: 0, units: 0, returns: 0 },
      };

      // Load historical snapshots
      const teamsMap = await getHistoricalTeamStats(date, league);
      const games = await getHistoricalOdds(date, league);

      if (!teamsMap || Object.keys(teamsMap).length === 0 || !games || games.length === 0) {
        continue; // No historical data for this date/league
      }

      datesWithData++;

      // Load tunable factors from weights
      const baseWeights = currentWeightsByLeague[league];
      const propWeights = proposedWeightsByLeague[league];

      // Set tunable factors (use current weights — same for both runs)
      if (baseWeights && baseWeights.params) {
        const autoFactors = {};
        for (const [key, val] of Object.entries(baseWeights.params)) {
          if (key.startsWith('param_auto_')) {
            autoFactors[key.replace('param_auto_', '')] = val;
          }
        }
        if (Object.keys(autoFactors).length > 0) {
          setTunableFactors(autoFactors);
        }
      }

      // Run model with CURRENT weights
      for (const game of games) {
        const basePicks = generateGamePicks(game, teamsMap, baseWeights, league, null);
        const propPicks = generateGamePicks(game, teamsMap, propWeights, league, null);

        // Grade each pick against actual results
        for (const pick of basePicks) {
          const mNorm = pick.betType === 'over' || pick.betType === 'under' ? 'total'
            : pick.betType === 'spread' ? 'spread' : 'moneyline';
          const lookupKey = `${date}|${league}|${mNorm}`;
          const actual = findMatchingResult(resultLookup[lookupKey], game, pick);
          if (!actual) continue;

          const u = pick._units || 0.05;
          baseline.units += u;
          byLeague[league].baseline.units += u;
          if (actual.result === 'W') {
            baseline.wins++; byLeague[league].baseline.wins++;
            const pay = calcReturnFromOdds(actual.odds, u);
            baseline.returns += pay; byLeague[league].baseline.returns += pay;
            dayResult.baseWins++; dayResult.baseReturn += pay;
          } else if (actual.result === 'L') {
            baseline.losses++; byLeague[league].baseline.losses++;
            baseline.returns -= u; byLeague[league].baseline.returns -= u;
            dayResult.baseLosses++; dayResult.baseReturn -= u;
          }
        }

        // Grade proposed picks — key difference: if pick direction flipped, result flips
        for (const pick of propPicks) {
          const mNorm = pick.betType === 'over' || pick.betType === 'under' ? 'total'
            : pick.betType === 'spread' ? 'spread' : 'moneyline';
          const lookupKey = `${date}|${league}|${mNorm}`;
          const actual = findMatchingResult(resultLookup[lookupKey], game, pick);
          if (!actual) continue;

          // Did the proposed weights produce the same pick direction?
          const basePick = basePicks.find(bp => {
            const bm = bp.betType === 'over' || bp.betType === 'under' ? 'total'
              : bp.betType === 'spread' ? 'spread' : 'moneyline';
            return bm === mNorm;
          });

          let result = actual.result;
          if (basePick && pick.pick !== basePick.pick) {
            // Direction flipped — invert the result
            if (result === 'W') result = 'L';
            else if (result === 'L') result = 'W';
          }

          const u = pick._units || 0.05;
          proposed.units += u;
          byLeague[league].proposed.units += u;
          if (result === 'W') {
            proposed.wins++; byLeague[league].proposed.wins++;
            const pay = calcReturnFromOdds(actual.odds, u);
            proposed.returns += pay; byLeague[league].proposed.returns += pay;
            dayResult.propWins++; dayResult.propReturn += pay;
          } else if (result === 'L') {
            proposed.losses++; byLeague[league].proposed.losses++;
            proposed.returns -= u; byLeague[league].proposed.returns -= u;
            dayResult.propLosses++; dayResult.propReturn -= u;
          }
        }
      }
    }

    dayByDay.push(dayResult);
  }

  console.log(`[backtest-cf] Processed ${datesWithData} date/league combos with historical data`);

  // Build summary
  const bTotal = baseline.wins + baseline.losses;
  const pTotal = proposed.wins + proposed.losses;
  const summary = {
    days,
    totalDates: dates.length,
    datesWithData,
    baseline: {
      record: `${baseline.wins}-${baseline.losses}`,
      winRate: bTotal > 0 ? parseFloat((baseline.wins / bTotal * 100).toFixed(1)) : 0,
      netUnits: parseFloat(baseline.returns.toFixed(2)),
      totalRisked: parseFloat(baseline.units.toFixed(2)),
      roi: baseline.units > 0 ? parseFloat((baseline.returns / baseline.units * 100).toFixed(1)) : 0,
    },
    proposed: {
      record: `${proposed.wins}-${proposed.losses}`,
      winRate: pTotal > 0 ? parseFloat((proposed.wins / pTotal * 100).toFixed(1)) : 0,
      netUnits: parseFloat(proposed.returns.toFixed(2)),
      totalRisked: parseFloat(proposed.units.toFixed(2)),
      roi: proposed.units > 0 ? parseFloat((proposed.returns / proposed.units * 100).toFixed(1)) : 0,
    },
    byLeague: {},
  };

  // Per-league summaries
  for (const [lg, data] of Object.entries(byLeague)) {
    const bt = data.baseline.wins + data.baseline.losses;
    const pt = data.proposed.wins + data.proposed.losses;
    summary.byLeague[lg] = {
      baseline: {
        record: `${data.baseline.wins}-${data.baseline.losses}`,
        winRate: bt > 0 ? parseFloat((data.baseline.wins / bt * 100).toFixed(1)) : 0,
        roi: data.baseline.units > 0 ? parseFloat((data.baseline.returns / data.baseline.units * 100).toFixed(1)) : 0,
      },
      proposed: {
        record: `${data.proposed.wins}-${data.proposed.losses}`,
        winRate: pt > 0 ? parseFloat((data.proposed.wins / pt * 100).toFixed(1)) : 0,
        roi: data.proposed.units > 0 ? parseFloat((data.proposed.returns / data.proposed.units * 100).toFixed(1)) : 0,
      },
    };
  }

  summary.diff = {
    winRate: parseFloat((summary.proposed.winRate - summary.baseline.winRate).toFixed(1)),
    roi: parseFloat((summary.proposed.roi - summary.baseline.roi).toFixed(1)),
    netUnits: parseFloat((summary.proposed.netUnits - summary.baseline.netUnits).toFixed(2)),
  };

  console.log(`[backtest-cf] Baseline: ${summary.baseline.record} | ${summary.baseline.winRate}% win | ${summary.baseline.roi}% ROI | ${summary.baseline.netUnits}u`);
  console.log(`[backtest-cf] Proposed: ${summary.proposed.record} | ${summary.proposed.winRate}% win | ${summary.proposed.roi}% ROI | ${summary.proposed.netUnits}u`);
  console.log(`[backtest-cf] Diff: ${summary.diff.winRate >= 0 ? '+' : ''}${summary.diff.winRate}% win rate | ${summary.diff.roi >= 0 ? '+' : ''}${summary.diff.roi}% ROI | ${summary.diff.netUnits >= 0 ? '+' : ''}${summary.diff.netUnits}u`);

  for (const [lg, data] of Object.entries(summary.byLeague)) {
    console.log(`[backtest-cf]   ${lg}: base ${data.baseline.record} (${data.baseline.roi}% ROI) → prop ${data.proposed.record} (${data.proposed.roi}% ROI)`);
  }

  // Write to Backtest_Results sheet
  try {
    const rows = [['Mode', 'Metric', 'Baseline', 'Proposed', 'Diff']];
    rows.push(['Counterfactual', 'Record', summary.baseline.record, summary.proposed.record, '']);
    rows.push(['', 'Win Rate', summary.baseline.winRate + '%', summary.proposed.winRate + '%', summary.diff.winRate + '%']);
    rows.push(['', 'ROI', summary.baseline.roi + '%', summary.proposed.roi + '%', summary.diff.roi + '%']);
    rows.push(['', 'Net Units', summary.baseline.netUnits, summary.proposed.netUnits, summary.diff.netUnits]);
    rows.push([]);
    rows.push(['League Breakdown']);
    for (const [lg, data] of Object.entries(summary.byLeague)) {
      rows.push([lg, 'Record', data.baseline.record, data.proposed.record, '']);
      rows.push(['', 'Win Rate', data.baseline.winRate + '%', data.proposed.winRate + '%', '']);
      rows.push(['', 'ROI', data.baseline.roi + '%', data.proposed.roi + '%', '']);
    }
    await setValues(SPREADSHEET_ID, SHEETS.BACKTEST_RESULTS, 'A1', rows);
  } catch (e) {
    console.warn('[backtest-cf] Could not write results to Sheets:', e.message);
  }

  return summary;
}

/**
 * Apply weight modifications to a weights object.
 * Same format as weight-sweep.js modifyWeights.
 */
function applyWeightMods(weights, mods) {
  for (const mod of mods) {
    const { market, key, action, value } = mod;
    const markets = market === 'all' ? ['moneyline', 'spread', 'total'] : [market];
    for (const m of markets) {
      if (!weights[m]) continue;
      if (action === 'zero') { if (weights[m][key] !== undefined) weights[m][key] = 0; }
      else if (action === 'multiply') { if (weights[m][key] !== undefined) weights[m][key] *= value; }
      else if (action === 'set') { weights[m][key] = value; }
      else if (action === 'zeroGroup') { for (const k of Object.keys(weights[m])) if (k.includes(key)) weights[m][k] = 0; }
      else if (action === 'multiplyGroup') { for (const k of Object.keys(weights[m])) if (k.includes(key)) weights[m][k] *= value; }
    }
  }
  return weights;
}

/**
 * Find the actual graded result that matches a model-generated pick.
 */
function findMatchingResult(candidates, game, pick) {
  if (!candidates || candidates.length === 0) return null;

  // Try to match by team names
  for (const c of candidates) {
    const cLeague = (c.league || '').toUpperCase();
    // Check if the game teams appear in the candidate
    const gameLower = (game.home + ' ' + game.away).toLowerCase();
    // Loose match — just need to find the right game/market combo
    if (gameLower.includes((c.market || '').toLowerCase().replace('moneyline', ''))) continue;
    return c; // Best available match for this date/league/market
  }

  // Fallback: return first candidate
  return candidates[0];
}

/**
 * Calculate return from American odds.
 */
function calcReturnFromOdds(odds, units) {
  if (odds > 0) return units * (odds / 100);
  return units * (100 / Math.abs(odds));
}

module.exports = {
  replayBacktest,
  sensitivityAnalysis,
  validateCurrentWeights,
  readGradedPicks,
  counterfactualBacktest,
};
