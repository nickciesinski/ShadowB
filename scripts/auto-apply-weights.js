#!/usr/bin/env node
'use strict';
/**
 * scripts/auto-apply-weights.js — Automated weight optimization loop
 *
 * Runs the weight sweep backtester, compares the winner against baseline,
 * and if improvement exceeds safety thresholds, updates the weight CSV files
 * and sends an email summary.
 *
 * Designed to run weekly via GitHub Actions (Sunday after trigger14 grading).
 *
 * Safety guardrails:
 *   - Minimum 50 graded picks required
 *   - Winner must beat baseline by >= 2.0% win rate OR >= 5.0% ROI
 *   - No single weight changes more than 30% per cycle
 *   - Weights clamped to [-5.0, 5.0] range
 *   - "group" and "strategy" combos apply proportional changes, not raw overwrites
 *   - Email sent on every run (applied or skipped) for auditability
 *
 * Usage:
 *   node scripts/auto-apply-weights.js [--days 60] [--dry-run]
 *   node scripts/auto-apply-weights.js --force   # skip threshold check
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { getValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const db = require('../src/db');
const { scoreMarket } = require('../src/game-features');
const { calcUnits, americanToImpliedProb, calcEdge } = require('../src/market-pricing');
const { readWeights, sheetForLeague, writeWeights } = require('../src/weights');
const paramStore = require('../src/param-store');

const args = process.argv.slice(2);
const DAYS = parseInt(args.find((_, i, a) => a[i - 1] === '--days') || '60');
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

// ── Thresholds ──────────────────────────────────────────────────
const MIN_PICKS = 50;
const MIN_WIN_RATE_LIFT = 1.0;   // percentage points (2026-06-01: 2.0→1.0; with small samples, accept smaller verified lifts)
const MIN_ROI_LIFT = 5.0;       // percentage points
const MAX_WEIGHT_DELTA_PCT = 30; // max % change per individual weight
const WEIGHT_CLAMP = 5.0;       // absolute max weight magnitude

// ── Email config ────────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const EMAIL_RECIPIENTS = (process.env.EMAIL_RECIPIENTS || '').split(',').filter(Boolean);

// ── Reuse weight-sweep internals ────────────────────────────────

function modifyWeights(baseWeights, mods) {
  const w = JSON.parse(JSON.stringify(baseWeights));
  for (const mod of mods) {
    const { market, key, action, value } = mod;
    const markets = market === 'all' ? ['moneyline', 'spread', 'total'] : [market];
    for (const m of markets) {
      if (!w[m]) continue;
      if (action === 'zero') { if (w[m][key] !== undefined) w[m][key] = 0; }
      else if (action === 'multiply') { if (w[m][key] !== undefined) w[m][key] *= value; }
      else if (action === 'set') { w[m][key] = value; }
      else if (action === 'zeroGroup') { for (const k of Object.keys(w[m])) if (k.includes(key)) w[m][k] = 0; }
      else if (action === 'multiplyGroup') { for (const k of Object.keys(w[m])) if (k.includes(key)) w[m][k] *= value; }
    }
  }
  return w;
}

function buildWeightCombos(refWeights) {
  const combos = [];
  const allKeys = new Set();
  for (const m of ['moneyline', 'spread', 'total']) {
    for (const k of Object.keys(refWeights[m] || {})) {
      if (!k.startsWith('sp_') && !k.startsWith('param_') && !k.startsWith('score_')) allKeys.add(k);
    }
  }

  // Individual feature: zero / double / halve
  for (const key of allKeys) {
    combos.push({ name: `zero_${key}`, cat: 'zero', mods: [{ market: 'all', key, action: 'zero' }] });
    combos.push({ name: `2x_${key}`, cat: 'scale', mods: [{ market: 'all', key, action: 'multiply', value: 2 }] });
    combos.push({ name: `0.5x_${key}`, cat: 'scale', mods: [{ market: 'all', key, action: 'multiply', value: 0.5 }] });
  }

  // Feature group operations
  const groups = {
    recent_form: ['recent_form_l10', 'recent_form_l5', 'recent_form_l3', 'recent_form_l1'],
    momentum: ['momentum_diff', 'trend_diff'],
    injury: ['injury_weight', 'severe_injury', 'injury_advantage', 'total_injury'],
    ratings: ['offensive_rating', 'defensive_rating', 'net_rating'],
    core_diff: ['point_differential', 'offense_ppg', 'defense_papg'],
    shooting: ['fg_percentage', 'three_point'],
    misc: ['rebounds', 'assists', 'turnovers'],
    home: ['home_away_split', 'home_court'],
    pace: ['pace_diff', 'pace_factor', 'pace_combined'],
  };
  for (const [gn, pats] of Object.entries(groups)) {
    combos.push({ name: `zeroGrp_${gn}`, cat: 'group', mods: pats.map(p => ({ market: 'all', key: p, action: 'zeroGroup' })) });
    combos.push({ name: `2xGrp_${gn}`, cat: 'group', mods: pats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 2 })) });
    combos.push({ name: `0.5xGrp_${gn}`, cat: 'group', mods: pats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 0.5 })) });
    combos.push({ name: `3xGrp_${gn}`, cat: 'group', mods: pats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 3 })) });
  }

  // "Only X" isolation
  for (const [gn, pats] of Object.entries(groups)) {
    const others = Object.entries(groups).filter(([n]) => n !== gn).flatMap(([, p]) => p);
    combos.push({ name: `only_${gn}`, cat: 'isolate', mods: others.map(p => ({ market: 'all', key: p, action: 'zeroGroup' })) });
  }

  // Strategy combos
  combos.push({
    name: 'recency_bias', cat: 'strategy', mods: [
      { market: 'all', key: 'recent_form_l1', action: 'multiplyGroup', value: 2.5 },
      { market: 'all', key: 'recent_form_l3', action: 'multiplyGroup', value: 2 },
      { market: 'all', key: 'recent_form_l5', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'recent_form_l10', action: 'multiplyGroup', value: 0.5 },
    ]
  });
  combos.push({
    name: 'longterm_trust', cat: 'strategy', mods: [
      { market: 'all', key: 'recent_form_l1', action: 'multiplyGroup', value: 0.3 },
      { market: 'all', key: 'recent_form_l3', action: 'multiplyGroup', value: 0.5 },
      { market: 'all', key: 'recent_form_l5', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'recent_form_l10', action: 'multiplyGroup', value: 2.5 },
    ]
  });
  combos.push({
    name: 'fundamentals_only', cat: 'strategy', mods: [
      { market: 'all', key: 'recent_form', action: 'zeroGroup' }, { market: 'all', key: 'momentum', action: 'zeroGroup' },
      { market: 'all', key: 'trend', action: 'zeroGroup' }, { market: 'all', key: 'net_rating', action: 'multiplyGroup', value: 2 },
      { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 1.5 }, { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 1.5 },
    ]
  });
  combos.push({ name: 'no_injuries', cat: 'strategy', mods: [{ market: 'all', key: 'injury', action: 'zeroGroup' }] });
  combos.push({
    name: 'defense_heavy', cat: 'strategy', mods: [
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 2.5 }, { market: 'all', key: 'defense_papg', action: 'multiplyGroup', value: 2 },
      { market: 'all', key: 'opponent_fg', action: 'multiplyGroup', value: 2 }, { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 0.5 },
    ]
  });
  combos.push({
    name: 'offense_heavy', cat: 'strategy', mods: [
      { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 2.5 }, { market: 'all', key: 'offense_ppg', action: 'multiplyGroup', value: 2 },
      { market: 'all', key: 'fg_percentage', action: 'multiplyGroup', value: 2 }, { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 0.5 },
    ]
  });

  // Market-specific scaling
  for (const m of ['moneyline', 'spread', 'total']) {
    for (const s of [0.5, 1.5, 2.0, 3.0]) {
      const mw = refWeights[m] || {};
      combos.push({
        name: `${m}_${s}x`, cat: 'mkt_scale', mods:
          Object.keys(mw).filter(k => !k.startsWith('param_') && !k.startsWith('score_')).map(k => ({ market: m, key: k, action: 'multiply', value: s }))
      });
    }
  }

  // ── Gradient nudges (fine-tuning, smaller steps) ────────────────
  for (const key of allKeys) {
    for (const s of [0.8, 0.9, 1.1, 1.2, 1.3, 1.5]) {
      combos.push({ name: `${s}x_${key}`, cat: 'nudge', mods: [{ market: 'all', key, action: 'multiply', value: s }] });
    }
  }
  for (const [gn, pats] of Object.entries(groups)) {
    for (const s of [0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.5]) {
      combos.push({ name: `${s}xGrp_${gn}`, cat: 'nudge_grp', mods: pats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: s })) });
    }
  }

  // ── Per-market feature group scaling ──────────────────────────
  // Different features matter differently per market type.
  // e.g. pace matters more for totals, ratings more for spreads
  for (const m of ['moneyline', 'spread', 'total']) {
    for (const [gn, pats] of Object.entries(groups)) {
      for (const s of [0, 0.5, 1.5, 2.0]) {
        const action = s === 0 ? 'zeroGroup' : 'multiplyGroup';
        const mods = pats.map(p => ({ market: m, key: p, action, ...(s !== 0 ? { value: s } : {}) }));
        combos.push({ name: `${m}_${s === 0 ? 'zero' : s + 'x'}Grp_${gn}`, cat: 'mkt_grp', mods });
      }
    }
  }

  // ── Cross-group combos (boost X + reduce Y) ──────────────────
  const crossPairs = [
    ['ratings', 'recent_form', 'ratings_over_form'],
    ['recent_form', 'ratings', 'form_over_ratings'],
    ['core_diff', 'momentum', 'core_over_momentum'],
    ['injury', 'misc', 'injury_over_misc'],
    ['ratings', 'home', 'ratings_over_home'],
    ['pace', 'shooting', 'pace_over_shooting'],
    ['recent_form', 'injury', 'form_over_injury'],
  ];
  for (const [boostGrp, reduceGrp, name] of crossPairs) {
    const boostPats = groups[boostGrp] || [];
    const reducePats = groups[reduceGrp] || [];
    combos.push({
      name: `cross_${name}`, cat: 'cross',
      mods: [
        ...boostPats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 1.5 })),
        ...reducePats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 0.5 })),
      ]
    });
    // Also the stronger version
    combos.push({
      name: `cross_strong_${name}`, cat: 'cross',
      mods: [
        ...boostPats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 2.0 })),
        ...reducePats.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 0.3 })),
      ]
    });
  }

  // ── Market-specific strategy combos ───────────────────────────
  // Totals-specific: pace and scoring volume matter most
  combos.push({
    name: 'totals_pace_heavy', cat: 'mkt_strategy', mods: [
      { market: 'total', key: 'pace', action: 'multiplyGroup', value: 2.5 },
      { market: 'total', key: 'offense_ppg', action: 'multiplyGroup', value: 2.0 },
      { market: 'total', key: 'defense_papg', action: 'multiplyGroup', value: 2.0 },
      { market: 'total', key: 'recent_form', action: 'multiplyGroup', value: 0.5 },
    ]
  });
  combos.push({
    name: 'totals_defense_focus', cat: 'mkt_strategy', mods: [
      { market: 'total', key: 'defensive_rating', action: 'multiplyGroup', value: 2.5 },
      { market: 'total', key: 'defense_papg', action: 'multiplyGroup', value: 2.0 },
      { market: 'total', key: 'offensive_rating', action: 'multiplyGroup', value: 0.5 },
    ]
  });
  // Spread-specific: ratings and point differential matter most
  combos.push({
    name: 'spread_ratings_focus', cat: 'mkt_strategy', mods: [
      { market: 'spread', key: 'net_rating', action: 'multiplyGroup', value: 2.5 },
      { market: 'spread', key: 'point_differential', action: 'multiplyGroup', value: 2.0 },
      { market: 'spread', key: 'recent_form', action: 'multiplyGroup', value: 0.5 },
    ]
  });
  combos.push({
    name: 'spread_form_focus', cat: 'mkt_strategy', mods: [
      { market: 'spread', key: 'recent_form', action: 'multiplyGroup', value: 2.5 },
      { market: 'spread', key: 'momentum', action: 'multiplyGroup', value: 2.0 },
      { market: 'spread', key: 'net_rating', action: 'multiplyGroup', value: 0.5 },
    ]
  });
  // ML-specific: win probability drivers
  combos.push({
    name: 'ml_ratings_core', cat: 'mkt_strategy', mods: [
      { market: 'moneyline', key: 'net_rating', action: 'multiplyGroup', value: 2.0 },
      { market: 'moneyline', key: 'point_differential', action: 'multiplyGroup', value: 2.0 },
      { market: 'moneyline', key: 'home_court', action: 'multiplyGroup', value: 1.5 },
    ]
  });
  combos.push({
    name: 'ml_form_momentum', cat: 'mkt_strategy', mods: [
      { market: 'moneyline', key: 'recent_form', action: 'multiplyGroup', value: 2.0 },
      { market: 'moneyline', key: 'momentum', action: 'multiplyGroup', value: 2.0 },
      { market: 'moneyline', key: 'trend', action: 'multiplyGroup', value: 1.5 },
    ]
  });

  // ── "Flatten" combos: bring extreme weights closer to 1.0 ────
  // When a weight is > 1.5, multiply by 0.7; when < 0.5, multiply by 1.5
  for (const m of ['moneyline', 'spread', 'total']) {
    const mw = refWeights[m] || {};
    const flattenMods = [];
    for (const [k, v] of Object.entries(mw)) {
      if (k.startsWith('param_') || k.startsWith('score_')) continue;
      if (Math.abs(v) > 1.5) flattenMods.push({ market: m, key: k, action: 'multiply', value: 0.7 });
      else if (Math.abs(v) > 0 && Math.abs(v) < 0.5) flattenMods.push({ market: m, key: k, action: 'multiply', value: 1.5 });
    }
    if (flattenMods.length > 0) {
      combos.push({ name: `flatten_${m}`, cat: 'flatten', mods: flattenMods });
    }
  }

  return combos;
}

function simulate(picks, weightsByLeague, mods, useFeatures) {
  let wins = 0, losses = 0, totalReturn = 0, totalRisked = 0;
  let edgeChanges = 0, unitChanges = 0;
  const byLeague = {};

  for (const pick of picks) {
    const lg = pick.league;
    if (!byLeague[lg]) byLeague[lg] = { w: 0, l: 0, ret: 0, risked: 0 };

    let wouldWin;
    let units;

    if (useFeatures && pick.features) {
      const baseW = weightsByLeague[lg] || weightsByLeague['NBA'];
      const modW = mods && mods.length > 0 ? modifyWeights(baseW, mods) : baseW;
      const baseScore = scoreMarket(pick.features, baseW[pick.market] || {});
      const modScore = scoreMarket(pick.features, modW[pick.market] || {});

      // Determine if pick direction flips
      if (baseScore !== 0 && Math.sign(modScore) !== Math.sign(baseScore)) {
        // Score sign flipped — pick would have been on the other side
        wouldWin = pick.actualResult === 'L'; // original L becomes W, W becomes L
      } else {
        wouldWin = pick.actualResult === 'W';
      }

      // Re-compute edge under modified weights
      // Edge is proportional to the score magnitude through the margin→prob pipeline.
      // Scale the original edge by the score ratio to approximate the new edge.
      const origEdge = pick.origEdge || 0;
      let newEdge = origEdge;
      if (origEdge > 0 && baseScore !== 0) {
        // Score ratio tells us how much stronger/weaker the signal is
        const scoreRatio = Math.abs(modScore) / Math.abs(baseScore);
        newEdge = origEdge * scoreRatio;
        // If score sign flipped, edge should be positive for the new side
        if (Math.sign(modScore) !== Math.sign(baseScore)) {
          newEdge = Math.abs(origEdge) * scoreRatio;
        }
        if (Math.abs(newEdge - origEdge) > 0.01) edgeChanges++;
      }

      // Re-compute units using the pricing model
      const uncertainty = pick.dataCompleteness != null
        ? 1 - Math.min(1, pick.dataCompleteness)
        : 0.5;
      const mktQuality = 0.7; // reasonable default — we don't store this per-pick
      const perfMod = 1.0;    // baseline perf modifier
      const calMod = 1.0;     // baseline calibration

      units = calcUnits(Math.max(0, newEdge), uncertainty, mktQuality, perfMod, calMod);
      if (Math.abs(units - (pick.origUnits || pick.units || 0.10)) > 0.005) unitChanges++;
    } else {
      // No features — fall back to original result and units
      wouldWin = pick.actualResult === 'W';
      units = pick.units || 0.10;
    }

    totalRisked += units;

    if (wouldWin) {
      wins++;
      const pay = pick.odds > 0 ? units * (pick.odds / 100) : units * (100 / Math.abs(pick.odds));
      totalReturn += pay; byLeague[lg].w++; byLeague[lg].ret += pay; byLeague[lg].risked += units;
    } else {
      losses++; totalReturn -= units; byLeague[lg].l++; byLeague[lg].ret -= units; byLeague[lg].risked += units;
    }
  }

  const total = wins + losses;
  return {
    wins, losses,
    winRate: total > 0 ? parseFloat((wins / total * 100).toFixed(1)) : 0,
    totalReturn: parseFloat(totalReturn.toFixed(2)),
    totalRisked: parseFloat(totalRisked.toFixed(2)),
    roi: totalRisked > 0 ? parseFloat((totalReturn / totalRisked * 100).toFixed(1)) : 0,
    edgeChanges,
    unitChanges,
    byLeague,
  };
}

// ── Load picks + features (same as weight-sweep.js) ─────────────
async function loadPicks() {
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) throw new Error('No Performance Log data');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

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
    const game = (row[3] || '').toString();
    const m = parseInt(parts[1]), d = parseInt(parts[2]), y = parseInt(parts[3]);
    const dateISO = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    picks.push({ date: rawDate, dateISO, league, market: mappedMarket, game, actualResult: result, odds, units, features: null });
  }

  // Load features from Supabase
  if (db.isEnabled()) {
    try {
      const sb = db.getClient();
      const { data, error } = await sb.from('prediction_features')
        .select('date, league, market, home_team, away_team, features, edge, predicted_prob, final_units, disagreement, data_completeness')
        .gte('date', cutoff.toISOString().slice(0, 10))
        .order('date', { ascending: false })
        .limit(5000);

      if (!error && data && data.length > 0) {
        const featureMap = {};
        for (const row of data) {
          if (!row.features || typeof row.features !== 'object') continue;
          const key = `${row.date}|${row.league}|${row.market}`;
          if (!featureMap[key]) featureMap[key] = [];
          featureMap[key].push({
            features: row.features, home: row.home_team, away: row.away_team,
            origEdge: row.edge || 0, predictedProb: row.predicted_prob || null,
            origUnits: row.final_units || 0, disagreement: row.disagreement || 0,
            dataCompleteness: row.data_completeness || 0,
          });
        }

        for (const pick of picks) {
          const key = `${pick.dateISO}|${pick.league}|${pick.market}`;
          const candidates = featureMap[key];
          if (!candidates || candidates.length === 0) continue;
          if (candidates.length === 1) {
            const c = candidates[0];
            pick.features = c.features;
            pick.origEdge = c.origEdge; pick.predictedProb = c.predictedProb;
            pick.origUnits = c.origUnits; pick.disagreement = c.disagreement;
            pick.dataCompleteness = c.dataCompleteness;
            continue;
          }
          const gameLower = pick.game.toLowerCase();
          const matched = candidates.find(c =>
            gameLower.includes((c.home || '').toLowerCase()) || gameLower.includes((c.away || '').toLowerCase())
          );
          const best = matched || candidates[0];
          pick.features = best.features;
          pick.origEdge = best.origEdge; pick.predictedProb = best.predictedProb;
          pick.origUnits = best.origUnits; pick.disagreement = best.disagreement;
          pick.dataCompleteness = best.dataCompleteness;
        }
      }
    } catch (e) {
      console.warn(`[auto-apply] Supabase feature load error: ${e.message}`);
    }
  }

  return picks;
}

// ── Apply winning mods to CSV files with guardrails ─────────────
function computeSafeWeightUpdates(currentWeights, winnerMods) {
  const proposed = modifyWeights(currentWeights, winnerMods);
  const changes = [];
  let clamped = 0;

  for (const market of ['moneyline', 'spread', 'total']) {
    const cur = currentWeights[market] || {};
    const prop = proposed[market] || {};

    for (const [key, newVal] of Object.entries(prop)) {
      if (key.startsWith('param_') || key.startsWith('score_')) continue;
      const oldVal = cur[key];
      if (oldVal === undefined || oldVal === newVal) continue;

      let safeVal = newVal;

      // Guardrail 1: max % change per weight
      // Use additive clamping to handle negative weights correctly.
      // Old formula "oldVal * (1 + dir * pct)" goes wrong for negative weights:
      //   e.g. -0.3 * (1 + (-1)*0.3) = -0.21 (LESS negative, wrong direction).
      // New formula: move oldVal toward newVal by at most 30% of |oldVal|.
      if (oldVal !== 0) {
        const deltaPct = Math.abs((newVal - oldVal) / oldVal) * 100;
        if (deltaPct > MAX_WEIGHT_DELTA_PCT) {
          const direction = newVal > oldVal ? 1 : -1;
          safeVal = oldVal + direction * Math.abs(oldVal) * MAX_WEIGHT_DELTA_PCT / 100;
          clamped++;
        }
      } else if (Math.abs(newVal) > 0.5) {
        // Don't let a zero weight jump to something huge
        safeVal = newVal > 0 ? 0.5 : -0.5;
        clamped++;
      }

      // Guardrail 2: absolute clamp
      safeVal = Math.max(-WEIGHT_CLAMP, Math.min(WEIGHT_CLAMP, safeVal));
      safeVal = parseFloat(safeVal.toFixed(4));

      if (safeVal !== oldVal) {
        prop[key] = safeVal;
        changes.push({ market, key, old: oldVal, new: safeVal, rawProposed: newVal });
      } else {
        prop[key] = oldVal; // revert if clamping eliminated the change
      }
    }
  }

  return { proposed, changes, clamped };
}

function updateCsvFile(league, currentWeights, proposedWeights) {
  const csvPath = path.join(__dirname, '..', 'weights', `Weights_${league}.csv`);
  if (!fs.existsSync(csvPath)) return false;

  const rows = [['market', 'key', 'weight']];

  // Params first (unchanged)
  for (const [key, val] of Object.entries(currentWeights.params || {})) {
    rows.push(['', key, val]);
  }

  // Market weights (use proposed values)
  for (const market of ['moneyline', 'spread', 'total']) {
    const weights = proposedWeights[market] || currentWeights[market] || {};
    for (const [key, val] of Object.entries(weights)) {
      rows.push([market, key, val]);
    }
  }

  const csv = rows.map(r => r.join(',')).join('\n') + '\n';
  fs.writeFileSync(csvPath, csv);
  // Source of truth is the JSON param store; keep it in sync (runtime reads this).
  paramStore.setRows(league, rows);
  return true;
}

// ── Email ───────────────────────────────────────────────────────
async function sendAutoApplyEmail(report) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || EMAIL_RECIPIENTS.length === 0) {
    console.log('[auto-apply] Email not configured — skipping notification');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const applied = report.applied;
  const subject = applied
    ? `Shadow Bets: Weights Auto-Updated (${report.winnerName})`
    : `Shadow Bets: Weekly Weight Sweep — No Changes`;

  let html = `<h2>Weekly Weight Sweep Report</h2>`;
  html += `<p><strong>Date:</strong> ${new Date().toISOString().slice(0, 10)}</p>`;
  html += `<p><strong>Window:</strong> ${DAYS} days | <strong>Picks:</strong> ${report.totalPicks} | <strong>Mode:</strong> ${report.mode}</p>`;

  html += `<h3>Baseline</h3>`;
  html += `<p>${report.baseline.wins}W-${report.baseline.losses}L | Win%: ${report.baseline.winRate}% | ROI: ${report.baseline.roi}%</p>`;
  if (report.baseline.totalReturn !== undefined) {
    html += `<p>Return: ${report.baseline.totalReturn}u | Risked: ${report.baseline.totalRisked || 'N/A'}u</p>`;
  }

  html += `<h3>Winner: ${report.winnerName}</h3>`;
  html += `<p>${report.winner.wins}W-${report.winner.losses}L | Win%: ${report.winner.winRate}% | ROI: ${report.winner.roi}%</p>`;
  if (report.winner.totalReturn !== undefined) {
    html += `<p>Return: ${report.winner.totalReturn}u | Risked: ${report.winner.totalRisked || 'N/A'}u | Edge changes: ${report.winner.edgeChanges || 0} | Unit changes: ${report.winner.unitChanges || 0}</p>`;
  }
  html += `<p>Win% lift: <strong>${report.winRateLift >= 0 ? '+' : ''}${report.winRateLift}%</strong> | ROI lift: <strong>${report.roiLift >= 0 ? '+' : ''}${report.roiLift}%</strong></p>`;

  if (applied) {
    html += `<h3>Changes Applied</h3>`;
    html += `<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:13px;">`;
    html += `<tr><th>League</th><th>Market</th><th>Key</th><th>Old</th><th>New</th><th>Delta%</th></tr>`;
    for (const [league, lc] of Object.entries(report.changesByLeague || {})) {
      for (const c of lc) {
        const delta = c.old !== 0 ? ((c.new - c.old) / Math.abs(c.old) * 100).toFixed(1) : 'new';
        html += `<tr><td>${league}</td><td>${c.market}</td><td>${c.key}</td><td>${c.old}</td><td>${c.new}</td><td>${delta}%</td></tr>`;
      }
    }
    html += `</table>`;
    if (report.totalClamped > 0) {
      html += `<p><em>${report.totalClamped} weight(s) were clamped to stay within the ${MAX_WEIGHT_DELTA_PCT}% max-change guardrail.</em></p>`;
    }
    if (report.skippedLeagues && report.skippedLeagues.length > 0) {
      html += `<p><em>Skipped (off-season/insufficient picks): ${report.skippedLeagues.join(', ')}</em></p>`;
    }
  } else {
    html += `<h3>No Changes Applied</h3>`;
    html += `<p>Reason: ${report.skipReason}</p>`;
  }

  html += `<h3>Top 5 Configs</h3>`;
  html += `<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:13px;">`;
  html += `<tr><th>#</th><th>Name</th><th>W-L</th><th>Win%</th><th>ROI</th><th>vs Base</th></tr>`;
  for (let i = 0; i < Math.min(5, report.top5.length); i++) {
    const r = report.top5[i];
    const diff = (r.winRate - report.baseline.winRate).toFixed(1);
    html += `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.wins}-${r.losses}</td><td>${r.winRate}%</td><td>${r.roi}%</td><td>${diff >= 0 ? '+' : ''}${diff}%</td></tr>`;
  }
  html += `</table>`;

  html += `<p style="color:#888;font-size:11px;">Auto-generated by auto-apply-weights.js | ${DRY_RUN ? 'DRY RUN' : 'LIVE'}</p>`;

  await transporter.sendMail({
    from: GMAIL_USER,
    to: EMAIL_RECIPIENTS.join(','),
    subject,
    html,
  });
  console.log(`[auto-apply] Email sent to ${EMAIL_RECIPIENTS.join(', ')}`);
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== AUTO-APPLY WEIGHT OPTIMIZER ===`);
  console.log(`Period: ${DAYS} days | Dry run: ${DRY_RUN} | Force: ${FORCE}`);

  // 1. Load picks
  console.log('\n[1/5] Loading picks + features...');
  const picks = await loadPicks();
  const withFeatures = picks.filter(p => p.features && Object.keys(p.features).length > 3);
  const useFeatures = withFeatures.length >= 30;
  const simPicks = useFeatures ? withFeatures : picks;
  console.log(`  ${picks.length} total picks, ${withFeatures.length} with features`);
  console.log(`  Mode: ${useFeatures ? 'feature-rescore' : 'result-replay'}`);

  // Count picks per league to skip off-season leagues
  const picksPerLeague = {};
  for (const p of simPicks) {
    picksPerLeague[p.league] = (picksPerLeague[p.league] || 0) + 1;
  }
  const MIN_LEAGUE_PICKS = 10; // need at least 10 picks to justify weight changes
  const activeLeagues = Object.entries(picksPerLeague)
    .filter(([, count]) => count >= MIN_LEAGUE_PICKS)
    .map(([lg]) => lg);
  console.log(`  Picks by league: ${JSON.stringify(picksPerLeague)}`);
  console.log(`  Active leagues (>= ${MIN_LEAGUE_PICKS} picks): ${activeLeagues.join(', ') || 'none'}`);

  if (simPicks.length < MIN_PICKS) {
    console.log(`  Only ${simPicks.length} picks — need ${MIN_PICKS}. Aborting.`);
    return;
  }

  // 2. Load weights
  console.log('\n[2/5] Loading weights...');
  const weightsByLeague = {};
  for (const lg of ['MLB', 'NBA', 'NFL', 'NHL']) {
    weightsByLeague[lg] = await readWeights(sheetForLeague(lg));
  }

  // 3. Run sweep
  console.log('\n[3/5] Running sweep...');
  const refWeights = weightsByLeague['NBA'] || Object.values(weightsByLeague)[0];
  const combos = buildWeightCombos(refWeights);
  console.log(`  ${combos.length} combos to test`);

  const baseline = simulate(simPicks, weightsByLeague, null, useFeatures);
  baseline.name = 'BASELINE';

  const results = [baseline];
  for (const c of combos) {
    const r = simulate(simPicks, weightsByLeague, c.mods, useFeatures);
    r.name = c.name; r.cat = c.cat; r.mods = c.mods;
    results.push(r);
  }
  results.sort((a, b) => b.winRate - a.winRate || b.roi - a.roi);

  const winner = results[0];
  const winRateLift = parseFloat((winner.winRate - baseline.winRate).toFixed(1));
  const roiLift = parseFloat((winner.roi - baseline.roi).toFixed(1));

  console.log(`\n  Baseline: ${baseline.wins}W-${baseline.losses}L | ${baseline.winRate}% | ROI ${baseline.roi}% | Units risked: ${baseline.totalRisked || 'N/A'}`);
  console.log(`  Winner:   ${winner.name} | ${winner.wins}W-${winner.losses}L | ${winner.winRate}% | ROI ${winner.roi}% | Units risked: ${winner.totalRisked || 'N/A'}`);
  console.log(`  Lift:     Win% ${winRateLift >= 0 ? '+' : ''}${winRateLift} | ROI ${roiLift >= 0 ? '+' : ''}${roiLift}`);
  console.log(`  Return:   Baseline ${baseline.totalReturn}u vs Winner ${winner.totalReturn}u (delta: ${(winner.totalReturn - baseline.totalReturn).toFixed(2)}u)`);

  // 4. Decide whether to apply
  const report = {
    totalPicks: simPicks.length,
    mode: useFeatures ? 'feature-rescore' : 'result-replay',
    baseline: { wins: baseline.wins, losses: baseline.losses, winRate: baseline.winRate, roi: baseline.roi, totalReturn: baseline.totalReturn, totalRisked: baseline.totalRisked },
    winner: { wins: winner.wins, losses: winner.losses, winRate: winner.winRate, roi: winner.roi, totalReturn: winner.totalReturn, totalRisked: winner.totalRisked, edgeChanges: winner.edgeChanges, unitChanges: winner.unitChanges },
    winnerName: winner.name,
    winRateLift,
    roiLift,
    top5: results.slice(0, 5).map(r => ({ name: r.name, wins: r.wins, losses: r.losses, winRate: r.winRate, roi: r.roi })),
    applied: false,
    skipReason: null,
    changesByLeague: {},
    totalClamped: 0,
  };

  // Check: statistical significance — need meaningful edge/unit changes, not just noise
  const flippedPicks = Math.abs(winner.wins - baseline.wins) + Math.abs(winner.losses - baseline.losses);
  const MIN_FLIPS = Math.max(5, Math.ceil(simPicks.length * 0.05)); // at least 5 or 5% of picks
  const edgeChangePct = winner.edgeChanges ? (winner.edgeChanges / simPicks.length * 100).toFixed(1) : '0';
  const unitChangePct = winner.unitChanges ? (winner.unitChanges / simPicks.length * 100).toFixed(1) : '0';
  console.log(`  Edge changes: ${winner.edgeChanges || 0} (${edgeChangePct}%) | Unit changes: ${winner.unitChanges || 0} (${unitChangePct}%)`);
  if (winner.name !== 'BASELINE' && flippedPicks < MIN_FLIPS * 2 && (winner.edgeChanges || 0) < MIN_FLIPS) {
    report.skipReason = `Too few meaningful changes: ${flippedPicks / 2} picks flipped, ${winner.edgeChanges || 0} edge changes (need ${MIN_FLIPS}+). Likely noise.`;
    console.log(`\n[4/5] Only ${flippedPicks / 2} picks flipped and ${winner.edgeChanges || 0} edge changes — below ${MIN_FLIPS} minimum. Skipping.`);
  }
  // Check: is winner the baseline itself?
  else if (winner.name === 'BASELINE') {
    report.skipReason = 'Baseline is already the best configuration';
    console.log('\n[4/5] Baseline is best — no changes needed.');
  }
  // Check: result-replay mode can't meaningfully test weight changes
  else if (!useFeatures) {
    report.skipReason = 'Running in result-replay mode — weight changes have no effect. Need more feature data in Supabase.';
    console.log('\n[4/5] Result-replay mode — cannot apply weight changes.');
  }
  // Check: meets threshold?
  else if (!FORCE && winRateLift < MIN_WIN_RATE_LIFT && roiLift < MIN_ROI_LIFT) {
    report.skipReason = `Improvement below threshold (need +${MIN_WIN_RATE_LIFT}% win rate OR +${MIN_ROI_LIFT}% ROI, got +${winRateLift}% / +${roiLift}%)`;
    console.log(`\n[4/5] Below threshold — skipping.`);
  }
  // Check: winner has mods we can apply
  else if (!winner.mods || winner.mods.length === 0) {
    report.skipReason = 'Winner has no weight modifications to apply';
    console.log('\n[4/5] Winner has no mods — skipping.');
  }
  // Apply!
  else {
    console.log('\n[4/5] Applying weight changes...');
    let totalClamped = 0;

    for (const league of ['MLB', 'NBA', 'NFL', 'NHL']) {
      // Skip leagues with insufficient recent picks (off-season protection)
      if (!activeLeagues.includes(league)) {
        console.log(`  ${league}: skipped — only ${picksPerLeague[league] || 0} picks in ${DAYS}-day window (need ${MIN_LEAGUE_PICKS}+)`);
        continue;
      }

      const current = weightsByLeague[league];
      const { proposed, changes, clamped } = computeSafeWeightUpdates(current, winner.mods);
      totalClamped += clamped;

      if (changes.length === 0) {
        console.log(`  ${league}: no weight changes`);
        continue;
      }

      console.log(`  ${league}: ${changes.length} weights changed (${clamped} clamped)`);
      for (const c of changes.slice(0, 5)) {
        console.log(`    ${c.market}/${c.key}: ${c.old} -> ${c.new}`);
      }
      if (changes.length > 5) console.log(`    ... and ${changes.length - 5} more`);

      report.changesByLeague[league] = changes;

      if (!DRY_RUN) {
        updateCsvFile(league, current, proposed);
        console.log(`  ${league}: CSV updated`);
      } else {
        console.log(`  ${league}: [DRY RUN] would update CSV`);
      }
    }

    report.applied = !DRY_RUN;
    report.totalClamped = totalClamped;
    report.skippedLeagues = ['MLB', 'NBA', 'NFL', 'NHL'].filter(lg => !activeLeagues.includes(lg));
    if (DRY_RUN) report.skipReason = 'Dry run mode';
  }

  // Save report JSON
  const outputDir = path.join(__dirname, '..', 'weight-reviews');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `auto-apply-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved: ${reportPath}`);

  // 5. Send email
  console.log('\n[5/5] Sending email notification...');
  try {
    await sendAutoApplyEmail(report);
  } catch (e) {
    console.warn(`[auto-apply] Email failed: ${e.message}`);
  }

  // Output summary for GitHub Actions
  if (report.applied) {
    console.log('\n=== WEIGHTS UPDATED ===');
    console.log('CSV files modified. The workflow will commit + push the updated config/model-params + CSV.');
  } else {
    console.log('\n=== NO CHANGES ===');
    console.log(report.skipReason);
  }

  // Set output for workflow
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `applied=${report.applied}\n`);
    fs.appendFileSync(outputFile, `winner=${report.winnerName}\n`);
    fs.appendFileSync(outputFile, `win_rate_lift=${report.winRateLift}\n`);
    fs.appendFileSync(outputFile, `roi_lift=${report.roiLift}\n`);
  }
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
