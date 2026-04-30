'use strict';
/**
 * src/backtesting.js — Historical Replay & Weight Validation
 *
 * Two modes:
 *
 * 1. **Replay backtest** — Takes proposed weight changes and replays them
 *    against the last N days of graded Performance Log data to estimate
 *    what ROI *would have been* under the new weights. Doesn't re-run
 *    the full model (we don't have historical team stats snapshots);
 *    instead it uses the recorded confidence/edge and recalculates unit
 *    sizing under the proposed modifier/weight changes.
 *
 * 2. **Weight sensitivity analysis** — For each weight key, runs +10%
 *    and -10% scenarios to see which direction improves ROI. Outputs a
 *    ranked list of weight changes by expected impact.
 *
 * Both modes write results to the Backtest_Results sheet and return
 * a summary object.
 */
const { getValues, setValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');
const db = require('./db');

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
  const raw = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
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

module.exports = {
  replayBacktest,
  sensitivityAnalysis,
  validateCurrentWeights,
  readGradedPicks,
};
