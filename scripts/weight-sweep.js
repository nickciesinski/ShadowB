'use strict';
/**
 * scripts/weight-sweep.js — Feature weight sweep backtester
 *
 * Tests actual CSV weight modifications against historical picks to find
 * which feature weight changes produce the most dramatic win rate improvements.
 *
 * Tests: zero individual features, double/halve features, feature group mods,
 * sign flips, recency bias, fundamentals-only, no-injuries, ultra-simple model.
 *
 * Run: node scripts/weight-sweep.js [--days 60] [--top 20] [--league NBA]
 *
 * Output: ranked table of weight combos by ROI, saved to
 * weight-reviews/weight-sweep-YYYY-MM-DD.json
 */
require('dotenv').config();
const { getValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const db = require('../src/db');
const { extractFeatures, scoreMarket, scoreToMarginAdj, scoreToTotalAdj } = require('../src/game-features');
const { getHistoricalTeamStats } = require('../src/snapshots');
const { americanToImpliedProb } = require('../src/market-pricing');
const fs = require('fs');
const path = require('path');

// ── CLI Args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DAYS = parseInt(args.find((_, i, a) => a[i-1] === '--days') || '60');
const TOP_N = parseInt(args.find((_, i, a) => a[i-1] === '--top') || '30');
const LEAGUE_FILTER = args.find((_, i, a) => a[i-1] === '--league') || null;

// ── Constants from game-model.js ────────────────────────────────
const STRENGTH_TO_MARGIN = { NBA: 40.0, NFL: 28.0, MLB: 8.0, NHL: 5.0 };
const AVG_TOTAL = { NBA: 226, NFL: 46, MLB: 8.8, NHL: 6.2 };

function projectMargin(homeStr, awayStr, league) {
  const diff = homeStr - awayStr;
  return diff * (STRENGTH_TO_MARGIN[league] || 20);
}

function projectWinProb(margin, league) {
  const scale = league === 'MLB' ? 8 : league === 'NHL' ? 5 : league === 'NFL' ? 14 : 12;
  return 1 / (1 + Math.exp(-margin / scale));
}

function projectTotal(homeStr, awayStr, avgTot) {
  const combined = (homeStr + awayStr) / 2;
  return avgTot * (1 + combined * 0.15);
}

// ── Weight reading ──────────────────────────────────────────────
async function loadWeights(league) {
  const sheetName = `Weights_${league}`;
  const rows = await getValues(SPREADSHEET_ID, sheetName);
  if (!rows || rows.length < 2) return { moneyline: {}, spread: {}, total: {}, params: {} };

  const weights = { moneyline: {}, spread: {}, total: {}, params: {} };
  for (const row of rows.slice(1)) {
    const [market, key, val] = row;
    if (!key) continue;
    const w = parseFloat(val) || 0;
    if (key.startsWith('param_')) {
      weights.params[key] = w;
    } else if (market && weights[market]) {
      weights[market][key] = w;
    }
  }
  return weights;
}

// ── Apply weight modifications ──────────────────────────────────
function modifyWeights(baseWeights, modifications) {
  // Deep clone
  const w = JSON.parse(JSON.stringify(baseWeights));
  
  for (const mod of modifications) {
    const { market, key, action, value } = mod;
    const markets = market === 'all' ? ['moneyline', 'spread', 'total'] : [market];
    
    for (const m of markets) {
      if (!w[m]) continue;
      
      if (action === 'set') {
        w[m][key] = value;
      } else if (action === 'multiply') {
        if (w[m][key] !== undefined) w[m][key] *= value;
      } else if (action === 'zero') {
        if (w[m][key] !== undefined) w[m][key] = 0;
      } else if (action === 'flip') {
        if (w[m][key] !== undefined) w[m][key] = -w[m][key];
      } else if (action === 'zeroGroup') {
        // Zero all keys matching a pattern
        for (const k of Object.keys(w[m])) {
          if (k.includes(key)) w[m][k] = 0;
        }
      } else if (action === 'multiplyGroup') {
        for (const k of Object.keys(w[m])) {
          if (k.includes(key)) w[m][k] *= value;
        }
      }
    }
  }
  return w;
}

// ── Simulate a pick with given weights ──────────────────────────
function simulatePick(pick, features, weights, csvDampen = 0.30) {
  const market = pick.market;
  const league = pick.league;
  const marketWeights = weights[market] || {};
  
  // CSV-weighted score
  const csvScore = scoreMarket(features, marketWeights);
  const csvAdj = market === 'total' 
    ? scoreToTotalAdj(csvScore, league)
    : scoreToMarginAdj(csvScore, league);
  
  // Base projection (from pick's stored features if available)
  const homeStr = (features.offensive_rating_diff || 0) * 0.5 + 0.5;
  const awayStr = 0.5 - (features.offensive_rating_diff || 0) * 0.5;
  
  if (market === 'total') {
    const baseTotal = projectTotal(homeStr, awayStr, AVG_TOTAL[league] || 200);
    const blended = baseTotal + csvAdj * csvDampen;
    const marketLine = pick.marketLine || blended;
    const ourTotal = blended;
    const predictedOver = ourTotal > marketLine;
    const actualOver = pick.actualResult === 'W' ? pick.pickSide === 'over' : pick.pickSide === 'under';
    
    // Did we pick the right side?
    if (predictedOver) {
      return pick.pickSide === 'over' ? 'agree' : 'disagree';
    } else {
      return pick.pickSide === 'under' ? 'agree' : 'disagree';
    }
  } else {
    const baseMargin = projectMargin(homeStr, awayStr, league);
    const blended = baseMargin + csvAdj * csvDampen;
    
    if (market === 'moneyline') {
      const winProb = projectWinProb(blended, league);
      const pickHome = pick.pickSide === 'home';
      const modelFavorsHome = winProb > 0.5;
      return (pickHome === modelFavorsHome) ? 'agree' : 'disagree';
    } else {
      // spread
      const spreadLine = pick.marketLine || 0;
      const modelCovers = blended > spreadLine;
      const pickCovers = pick.pickSide === 'home';
      return (pickCovers === modelCovers) ? 'agree' : 'disagree';
    }
  }
}

// ── Build test combos ───────────────────────────────────────────
function buildWeightCombos(baseWeights) {
  const combos = [];
  
  // Get all unique feature keys across markets
  const allKeys = new Set();
  for (const market of ['moneyline', 'spread', 'total']) {
    for (const key of Object.keys(baseWeights[market] || {})) {
      if (!key.startsWith('sp_')) allKeys.add(key); // Skip sp_ (Supabase-powered) features for now
    }
  }
  
  // ── 1. Zero individual features (find noise) ──────────────────
  for (const key of allKeys) {
    combos.push({
      name: `zero_${key}`,
      category: 'zero_feature',
      mods: [{ market: 'all', key, action: 'zero' }],
    });
  }
  
  // ── 2. Double individual features ─────────────────────────────
  for (const key of allKeys) {
    combos.push({
      name: `double_${key}`,
      category: 'scale_feature',
      mods: [{ market: 'all', key, action: 'multiply', value: 2.0 }],
    });
  }
  
  // ── 3. Halve individual features ──────────────────────────────
  for (const key of allKeys) {
    combos.push({
      name: `halve_${key}`,
      category: 'scale_feature',
      mods: [{ market: 'all', key, action: 'multiply', value: 0.5 }],
    });
  }
  
  // ── 4. Feature group modifications ────────────────────────────
  const groups = {
    recent_form: ['recent_form_l10', 'recent_form_l5', 'recent_form_l3', 'recent_form_l1'],
    momentum: ['momentum_diff', 'trend_diff'],
    injury: ['injury_weight', 'severe_injury', 'injury_advantage', 'total_injury'],
    ratings: ['offensive_rating', 'defensive_rating', 'net_rating'],
    core_diff: ['point_differential', 'offense_ppg', 'defense_papg'],
    shooting: ['fg_percentage', 'three_point'],
    misc_stats: ['rebounds', 'assists', 'turnovers'],
    home: ['home_away_split', 'home_court'],
    pace: ['pace_diff', 'pace_factor', 'pace_combined'],
  };
  
  for (const [groupName, patterns] of Object.entries(groups)) {
    // Zero the group
    combos.push({
      name: `zeroGroup_${groupName}`,
      category: 'group_zero',
      mods: patterns.map(p => ({ market: 'all', key: p, action: 'zeroGroup' })),
    });
    
    // Double the group
    combos.push({
      name: `doubleGroup_${groupName}`,
      category: 'group_scale',
      mods: patterns.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 2.0 })),
    });
    
    // Halve the group
    combos.push({
      name: `halveGroup_${groupName}`,
      category: 'group_scale',
      mods: patterns.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 0.5 })),
    });
    
    // Triple the group
    combos.push({
      name: `tripleGroup_${groupName}`,
      category: 'group_scale',
      mods: patterns.map(p => ({ market: 'all', key: p, action: 'multiplyGroup', value: 3.0 })),
    });
  }
  
  // ── 5. "Only X" combos (isolate single feature groups) ────────
  for (const [groupName, patterns] of Object.entries(groups)) {
    const allPatterns = Object.values(groups).flat();
    const otherPatterns = allPatterns.filter(p => !patterns.includes(p));
    combos.push({
      name: `only_${groupName}`,
      category: 'isolation',
      mods: otherPatterns.map(p => ({ market: 'all', key: p, action: 'zeroGroup' })),
    });
  }
  
  // ── 6. Sign flips on momentum/trend/form features ─────────────
  const flipTargets = ['momentum_diff', 'trend_diff', 'recent_form_l1', 'recent_form_l3'];
  for (const key of flipTargets) {
    combos.push({
      name: `flip_${key}`,
      category: 'sign_flip',
      mods: [{ market: 'all', key, action: 'multiplyGroup', value: -1 }],
    });
  }
  
  // ── 7. Recency bias test (boost short-term, reduce long-term) ─
  combos.push({
    name: 'recency_bias',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'recent_form_l1', action: 'multiplyGroup', value: 2.5 },
      { market: 'all', key: 'recent_form_l3', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'recent_form_l5', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'recent_form_l10', action: 'multiplyGroup', value: 0.5 },
    ],
  });
  
  // ── 8. Long-term trust (opposite of recency) ─────────────────
  combos.push({
    name: 'longterm_trust',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'recent_form_l1', action: 'multiplyGroup', value: 0.3 },
      { market: 'all', key: 'recent_form_l3', action: 'multiplyGroup', value: 0.5 },
      { market: 'all', key: 'recent_form_l5', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'recent_form_l10', action: 'multiplyGroup', value: 2.5 },
    ],
  });
  
  // ── 9. Fundamentals only (zero form/momentum, boost ratings) ──
  combos.push({
    name: 'fundamentals_only',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'recent_form', action: 'zeroGroup' },
      { market: 'all', key: 'momentum', action: 'zeroGroup' },
      { market: 'all', key: 'trend', action: 'zeroGroup' },
      { market: 'all', key: 'net_rating', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 1.5 },
    ],
  });
  
  // ── 10. No injuries test ──────────────────────────────────────
  combos.push({
    name: 'no_injuries',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'injury', action: 'zeroGroup' },
    ],
  });
  
  // ── 11. Ultra-simple model (only net_rating + point_diff + home) ─
  combos.push({
    name: 'ultra_simple',
    category: 'strategy',
    mods: [
      // Zero everything first
      ...Array.from(allKeys).filter(k => 
        !k.includes('net_rating') && 
        !k.includes('point_differential') && 
        !k.includes('home_court')
      ).map(k => ({ market: 'all', key: k, action: 'zero' })),
    ],
  });
  
  // ── 12. Max injury weight ─────────────────────────────────────
  combos.push({
    name: 'max_injury_weight',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'injury', action: 'multiplyGroup', value: 3.0 },
    ],
  });
  
  // ── 13. csvDampen variations ──────────────────────────────────
  for (const dampVal of [0.10, 0.20, 0.40, 0.50, 0.60, 0.80, 1.00]) {
    combos.push({
      name: `csvDampen_${dampVal}`,
      category: 'dampen',
      csvDampen: dampVal,
      mods: [],
    });
  }
  
  // ── 14. Market-specific weight scaling ────────────────────────
  for (const market of ['moneyline', 'spread', 'total']) {
    for (const scale of [0.5, 1.5, 2.0, 3.0]) {
      combos.push({
        name: `${market}_scale_${scale}x`,
        category: 'market_scale',
        mods: Object.keys(baseWeights[market] || {}).map(k => ({
          market, key: k, action: 'multiply', value: scale,
        })),
      });
    }
  }
  
  // ── 15. Defense-heavy model ───────────────────────────────────
  combos.push({
    name: 'defense_heavy',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 2.5 },
      { market: 'all', key: 'defense_papg', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'opponent_fg', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 0.5 },
      { market: 'all', key: 'offense_ppg', action: 'multiplyGroup', value: 0.5 },
    ],
  });
  
  // ── 16. Offense-heavy model ───────────────────────────────────
  combos.push({
    name: 'offense_heavy',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 2.5 },
      { market: 'all', key: 'offense_ppg', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'fg_percentage', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 0.5 },
      { market: 'all', key: 'defense_papg', action: 'multiplyGroup', value: 0.5 },
    ],
  });
  
  // ── 17. Turnovers matter more ─────────────────────────────────
  combos.push({
    name: 'turnovers_heavy',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'turnovers', action: 'multiplyGroup', value: 3.0 },
    ],
  });
  
  // ── 18. Shooting focus ────────────────────────────────────────
  combos.push({
    name: 'shooting_focus',
    category: 'strategy',
    mods: [
      { market: 'all', key: 'fg_percentage', action: 'multiplyGroup', value: 2.5 },
      { market: 'all', key: 'three_point', action: 'multiplyGroup', value: 2.5 },
    ],
  });
  
  // ── 19. Combined best-guess improvements ──────────────────────
  combos.push({
    name: 'combo_defense_noform',
    category: 'combined',
    mods: [
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 2.0 },
      { market: 'all', key: 'recent_form', action: 'zeroGroup' },
      { market: 'all', key: 'momentum', action: 'zeroGroup' },
    ],
  });
  
  combos.push({
    name: 'combo_ratings_heavy_noinjury',
    category: 'combined',
    mods: [
      { market: 'all', key: 'net_rating', action: 'multiplyGroup', value: 2.5 },
      { market: 'all', key: 'offensive_rating', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 1.5 },
      { market: 'all', key: 'injury', action: 'zeroGroup' },
    ],
  });
  
  combos.push({
    name: 'combo_simple_plus_defense',
    category: 'combined',
    mods: [
      { market: 'all', key: 'recent_form', action: 'zeroGroup' },
      { market: 'all', key: 'momentum', action: 'zeroGroup' },
      { market: 'all', key: 'trend', action: 'zeroGroup' },
      { market: 'all', key: 'rebounds', action: 'zeroGroup' },
      { market: 'all', key: 'assists', action: 'zeroGroup' },
      { market: 'all', key: 'fg_percentage', action: 'zeroGroup' },
      { market: 'all', key: 'three_point', action: 'zeroGroup' },
      { market: 'all', key: 'defensive_rating', action: 'multiplyGroup', value: 2.0 },
    ],
  });
  
  combos.push({
    name: 'combo_dampen60_fundamentals',
    category: 'combined',
    csvDampen: 0.60,
    mods: [
      { market: 'all', key: 'recent_form', action: 'zeroGroup' },
      { market: 'all', key: 'momentum', action: 'zeroGroup' },
      { market: 'all', key: 'trend', action: 'zeroGroup' },
    ],
  });
  
  combos.push({
    name: 'combo_dampen80_ratingsfocus',
    category: 'combined',
    csvDampen: 0.80,
    mods: [
      { market: 'all', key: 'recent_form', action: 'zeroGroup' },
      { market: 'all', key: 'momentum', action: 'zeroGroup' },
      { market: 'all', key: 'trend', action: 'zeroGroup' },
      { market: 'all', key: 'rebounds', action: 'zeroGroup' },
      { market: 'all', key: 'assists', action: 'zeroGroup' },
      { market: 'all', key: 'net_rating', action: 'multiplyGroup', value: 2.0 },
    ],
  });

  return combos;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== WEIGHT SWEEP BACKTESTER ===`);
  console.log(`Period: last ${DAYS} days | Top: ${TOP_N}`);
  if (LEAGUE_FILTER) console.log(`League filter: ${LEAGUE_FILTER}`);
  
  // 1. Load Performance Log
  console.log('\n[1/7] Loading Performance Log...');
  const perfRows = await getValues(SPREADSHEET_ID, 'Performance Log');
  if (!perfRows || perfRows.length < 2) throw new Error('No Performance Log data');
  
  const headers = perfRows[0];
  const dateIdx = headers.indexOf('Date');
  const leagueIdx = headers.indexOf('League');
  const marketIdx = headers.indexOf('Market');
  const pickIdx = headers.indexOf('Pick');
  const resultIdx = headers.indexOf('Result');
  const oddsIdx = headers.indexOf('Odds');
  const unitsIdx = headers.indexOf('Units');
  const edgeIdx = headers.indexOf('Edge');
  const confIdx = headers.indexOf('Confidence');
  
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);
  
  const picks = [];
  for (let i = 1; i < perfRows.length; i++) {
    const row = perfRows[i];
    if (!row[dateIdx] || !row[resultIdx]) continue;
    
    const result = row[resultIdx];
    if (result !== 'W' && result !== 'L') continue;
    
    const dateParts = row[dateIdx].split('/');
    if (dateParts.length !== 3) continue;
    const pickDate = new Date(`${dateParts[2]}-${dateParts[0].padStart(2,'0')}-${dateParts[1].padStart(2,'0')}`);
    if (pickDate < cutoff) continue;
    
    const league = row[leagueIdx];
    if (LEAGUE_FILTER && league !== LEAGUE_FILTER) continue;
    
    const market = (row[marketIdx] || '').toLowerCase().replace(/\s+/g, '');
    const mappedMarket = market.includes('spread') ? 'spread' : market.includes('total') ? 'total' : 'moneyline';
    const odds = parseInt(row[oddsIdx]) || -110;
    const units = parseFloat(row[unitsIdx]) || 0;
    const edge = parseFloat(row[edgeIdx]) || 0;
    
    picks.push({
      date: row[dateIdx],
      dateISO: `${dateParts[2]}-${dateParts[0].padStart(2,'0')}-${dateParts[1].padStart(2,'0')}`,
      league,
      market: mappedMarket,
      pick: row[pickIdx],
      actualResult: result,
      odds,
      units,
      edge,
      confidence: parseFloat(row[confIdx]) || 5,
      pickSide: row[pickIdx]?.toLowerCase().includes('over') ? 'over' :
                row[pickIdx]?.toLowerCase().includes('under') ? 'under' :
                row[pickIdx]?.toLowerCase().includes('away') ? 'away' : 'home',
    });
  }
  console.log(`  Loaded ${picks.length} graded picks in ${DAYS}-day window`);
  
  // 2. Load prediction features from Supabase
  console.log('\n[2/7] Loading prediction features from Supabase...');
  let featureMap = {};
  let featuresFound = 0;
  
  if (db.isEnabled()) {
    try {
      const client = db.getClient();
      const cutoffISO = cutoff.toISOString().slice(0, 10);
      const { data, error } = await client
        .from('prediction_features')
        .select('pick_date, league, market, features')
        .gte('pick_date', cutoffISO)
        .order('pick_date', { ascending: false });
      
      if (data && !error) {
        for (const row of data) {
          const key = `${row.pick_date}|${row.league}|${row.market}`;
          if (row.features && typeof row.features === 'object') {
            featureMap[key] = row.features;
            featuresFound++;
          }
        }
      }
    } catch (e) {
      console.log(`  Supabase error: ${e.message}`);
    }
  }
  console.log(`  Features loaded: ${featuresFound}`);
  
  // 3. Load current weights per league
  console.log('\n[3/7] Loading weight sheets...');
  const leagues = LEAGUE_FILTER ? [LEAGUE_FILTER] : ['NBA', 'NHL', 'MLB', 'NFL'];
  const weightsByLeague = {};
  for (const lg of leagues) {
    try {
      weightsByLeague[lg] = await loadWeights(lg);
      const keyCount = Object.keys(weightsByLeague[lg].moneyline || {}).length;
      console.log(`  ${lg}: ${keyCount} moneyline keys loaded`);
    } catch (e) {
      console.log(`  ${lg}: failed to load (${e.message})`);
      weightsByLeague[lg] = { moneyline: {}, spread: {}, total: {}, params: {} };
    }
  }
  
  // 4. Build combos
  console.log('\n[4/7] Building weight combos...');
  // Use NBA weights as the reference for feature keys
  const refLeague = weightsByLeague['NBA'] || weightsByLeague[Object.keys(weightsByLeague)[0]];
  const combos = buildWeightCombos(refLeague);
  console.log(`  Generated ${combos.length} weight combinations to test`);
  
  // 5. Match picks to features
  console.log('\n[5/7] Matching picks to features...');
  const picksWithFeatures = [];
  let matchCount = 0;
  
  for (const pick of picks) {
    // Try to find features from Supabase
    const key = `${pick.dateISO}|${pick.league}|${pick.market}`;
    const features = featureMap[key];
    
    if (features && Object.keys(features).length > 3) {
      picksWithFeatures.push({ ...pick, features });
      matchCount++;
    }
  }
  
  // If we have fewer than 50 picks with features, use all picks and simulate without features
  const usePicks = picksWithFeatures.length >= 50 ? picksWithFeatures : picks;
  const hasFeatures = picksWithFeatures.length >= 50;
  console.log(`  Picks with features: ${matchCount}/${picks.length}`);
  console.log(`  Using ${hasFeatures ? 'feature-based' : 'result-replay'} simulation (${usePicks.length} picks)`);
  
  // 6. Run sweep
  console.log('\n[6/7] Running weight sweep...');
  const results = [];
  
  // Baseline: current production weights
  const baselineResult = runSimulation(usePicks, weightsByLeague, null, 0.30, hasFeatures);
  baselineResult.name = 'BASELINE (current production)';
  baselineResult.category = 'baseline';
  results.push(baselineResult);
  
  for (let ci = 0; ci < combos.length; ci++) {
    const combo = combos[ci];
    if ((ci + 1) % 50 === 0) console.log(`  Progress: ${ci + 1}/${combos.length}`);
    
    const csvDampen = combo.csvDampen || 0.30;
    const result = runSimulation(usePicks, weightsByLeague, combo.mods, csvDampen, hasFeatures);
    result.name = combo.name;
    result.category = combo.category;
    result.csvDampen = csvDampen;
    results.push(result);
  }
  
  // 7. Sort and display
  results.sort((a, b) => b.roi - a.roi || b.winRate - a.winRate);
  
  console.log(`\n=== TOP ${TOP_N} WEIGHT CONFIGURATIONS ===`);
  console.log(`${'Rank'.padEnd(5)} ${'Name'.padEnd(45)} ${'Category'.padEnd(15)} ${'W-L'.padEnd(10)} ${'Win%'.padEnd(7)} ${'ROI'.padEnd(8)} ${'Units'.padEnd(10)} ${'vs Base'.padEnd(8)}`);
  console.log('-'.repeat(110));
  
  for (let i = 0; i < Math.min(TOP_N, results.length); i++) {
    const r = results[i];
    const vsBase = (r.roi - baselineResult.roi).toFixed(1);
    const prefix = vsBase > 0 ? '+' : '';
    console.log(
      `${(i + 1 + '.').padEnd(5)} ${r.name.padEnd(45)} ${(r.category || '').padEnd(15)} ` +
      `${(r.wins + '-' + r.losses).padEnd(10)} ${(r.winRate + '%').padEnd(7)} ${(r.roi + '%').padEnd(8)} ` +
      `${r.totalReturn.padEnd(10)} ${prefix}${vsBase}%`
    );
  }
  
  // Show baseline position
  const baseIdx = results.indexOf(baselineResult);
  console.log('-'.repeat(110));
  console.log(`BASELINE position: rank #${baseIdx + 1} of ${results.length}`);
  console.log(`BASELINE: ${baselineResult.wins}-${baselineResult.losses} | ${baselineResult.winRate}% | ${baselineResult.totalReturn} units | ROI ${baselineResult.roi}%`);
  
  // League breakdown for top 5
  console.log('\n=== TOP 5 — LEAGUE BREAKDOWN ===');
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    console.log(`\n${i + 1}. ${r.name} (ROI: ${r.roi}%, vs baseline: ${(r.roi - baselineResult.roi).toFixed(1)}%)`);
    for (const [lg, lr] of Object.entries(r.leagueResults || {})) {
      const total = lr.w + lr.l;
      const pct = total > 0 ? (lr.w / total * 100).toFixed(1) : '0.0';
      console.log(`   ${lg}: ${lr.w}-${lr.l} (${pct}%) → ${lr.ret.toFixed(2)} units`);
    }
  }
  
  // Save results
  const outputDir = path.join(__dirname, '..', 'weight-reviews');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `weight-sweep-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputFile, JSON.stringify({
    runDate: new Date().toISOString(),
    days: DAYS,
    leagueFilter: LEAGUE_FILTER,
    totalPicks: picks.length,
    picksWithFeatures: matchCount,
    simulationMode: hasFeatures ? 'feature-based' : 'result-replay',
    combosTestedCount: combos.length,
    baselineRank: baseIdx + 1,
    baseline: baselineResult,
    top30: results.slice(0, 30),
    allResults: results,
  }, null, 2));
  console.log(`\nFull results saved to: ${outputFile}`);
  
  // Recommendations
  console.log('\n=== RECOMMENDATIONS ===');
  const improvements = results.filter(r => r.roi > baselineResult.roi && r.category !== 'baseline');
  console.log(`${improvements.length} configurations beat baseline`);
  
  if (improvements.length > 0) {
    const topImprove = improvements[0];
    console.log(`\nBest improvement: "${topImprove.name}"`);
    console.log(`  ROI: ${baselineResult.roi}% → ${topImprove.roi}% (+${(topImprove.roi - baselineResult.roi).toFixed(1)}%)`);
    console.log(`  Win rate: ${baselineResult.winRate}% → ${topImprove.winRate}%`);
    console.log(`  Category: ${topImprove.category}`);
  }
  
  // Noise features (zeroing them improves or doesn't hurt)
  const noiseFeatures = results
    .filter(r => r.category === 'zero_feature' && r.roi >= baselineResult.roi)
    .map(r => ({ name: r.name.replace('zero_', ''), roi: r.roi, vsBase: (r.roi - baselineResult.roi).toFixed(1) }));
  
  if (noiseFeatures.length > 0) {
    console.log(`\nPotential noise features (zeroing them doesn't hurt or helps):`);
    for (const nf of noiseFeatures.slice(0, 10)) {
      console.log(`  ${nf.name}: ROI ${nf.roi}% (${nf.vsBase >= 0 ? '+' : ''}${nf.vsBase}% vs baseline)`);
    }
  }
}

// ── Simulation runner ───────────────────────────────────────────
function runSimulation(picks, weightsByLeague, mods, csvDampen, hasFeatures) {
  let wins = 0, losses = 0, totalReturn = 0;
  const leagueResults = {};
  
  for (const pick of picks) {
    const league = pick.league;
    if (!leagueResults[league]) leagueResults[league] = { w: 0, l: 0, ret: 0 };
    
    let wouldWin;
    
    if (hasFeatures && pick.features) {
      // Feature-based simulation: re-score with modified weights
      const baseWeights = weightsByLeague[league] || weightsByLeague['NBA'];
      const modWeights = mods && mods.length > 0 ? modifyWeights(baseWeights, mods) : baseWeights;
      const agreement = simulatePick(pick, pick.features, modWeights, csvDampen);
      
      // If we agree with original pick direction, keep original result
      // If we disagree, flip the result
      if (agreement === 'agree') {
        wouldWin = pick.actualResult === 'W';
      } else {
        wouldWin = pick.actualResult === 'L'; // disagreement = we'd pick opposite → flip W/L
      }
    } else {
      // Result replay: just use actual result (only useful for sizing/filter tests)
      wouldWin = pick.actualResult === 'W';
    }
    
    // Calculate payout
    const odds = pick.odds;
    const impliedProb = americanToImpliedProb(odds);
    const units = pick.units || 0.10;
    
    if (wouldWin) {
      wins++;
      const payout = odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
      totalReturn += payout;
      leagueResults[league].w++;
      leagueResults[league].ret += payout;
    } else {
      losses++;
      totalReturn -= units;
      leagueResults[league].l++;
      leagueResults[league].ret -= units;
    }
  }
  
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : '0.0';
  const roi = total > 0 ? (totalReturn / (total * 0.10) * 100).toFixed(1) : '0.0';
  
  return {
    wins, losses,
    winRate,
    totalReturn: totalReturn.toFixed(2),
    roi,
    leagueResults,
  };
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
