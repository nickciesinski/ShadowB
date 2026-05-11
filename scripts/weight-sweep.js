'use strict';
/**
 * scripts/weight-sweep.js — Feature weight sweep backtester
 *
 * Tests actual CSV weight modifications against historical picks to find
 * which feature weight changes produce the most dramatic win rate improvements.
 *
 * Borrows proven data-loading from backtest-sweep.js (column indices, Supabase query).
 *
 * Run: node scripts/weight-sweep.js [--days 60] [--top 30] [--league NBA]
 */
require('dotenv').config();
const { getValues } = require('../src/sheets');
const { SPREADSHEET_ID, SHEETS } = require('../src/config');
const db = require('../src/db');
const { scoreMarket, scoreToMarginAdj, scoreToTotalAdj } = require('../src/game-features');
const { americanToImpliedProb } = require('../src/market-pricing');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DAYS = parseInt(args.find((_, i, a) => a[i-1] === '--days') || '60');
const TOP_N = parseInt(args.find((_, i, a) => a[i-1] === '--top') || '30');
const LEAGUE_FILTER = args.find((_, i, a) => a[i-1] === '--league') || null;

const STRENGTH_TO_MARGIN = { NBA: 40.0, NFL: 28.0, MLB: 8.0, NHL: 5.0 };
const AVG_TOTAL = { NBA: 226, NFL: 46, MLB: 8.8, NHL: 6.2 };

function projectWinProb(margin, league) {
  const scale = league === 'MLB' ? 8 : league === 'NHL' ? 5 : league === 'NFL' ? 14 : 12;
  return 1 / (1 + Math.exp(-margin / scale));
}

// ── Load weights from Sheets ────────────────────────────────────
async function loadAllWeights() {
  const { readWeights, sheetForLeague } = require('../src/weights');
  const all = {};
  for (const lg of ['MLB', 'NBA', 'NFL', 'NHL']) {
    all[lg] = await readWeights(sheetForLeague(lg));
  }
  return all;
}

// ── Apply weight modifications (deep clone + mutate) ────────────
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

// ── Build all weight combos to test ─────────────────────────────
function buildWeightCombos(refWeights) {
  const combos = [];
  const allKeys = new Set();
  for (const m of ['moneyline', 'spread', 'total']) {
    for (const k of Object.keys(refWeights[m] || {})) {
      if (!k.startsWith('sp_') && !k.startsWith('param_') && !k.startsWith('score_')) allKeys.add(k);
    }
  }

  // 1. Zero each feature
  for (const key of allKeys) combos.push({ name: `zero_${key}`, cat: 'zero', mods: [{ market:'all', key, action:'zero' }] });
  // 2. Double each feature
  for (const key of allKeys) combos.push({ name: `2x_${key}`, cat: 'scale', mods: [{ market:'all', key, action:'multiply', value:2 }] });
  // 3. Halve each feature
  for (const key of allKeys) combos.push({ name: `0.5x_${key}`, cat: 'scale', mods: [{ market:'all', key, action:'multiply', value:0.5 }] });

  // 4. Feature group operations
  const groups = {
    recent_form: ['recent_form_l10','recent_form_l5','recent_form_l3','recent_form_l1'],
    momentum: ['momentum_diff','trend_diff'],
    injury: ['injury_weight','severe_injury','injury_advantage','total_injury'],
    ratings: ['offensive_rating','defensive_rating','net_rating'],
    core_diff: ['point_differential','offense_ppg','defense_papg'],
    shooting: ['fg_percentage','three_point'],
    misc: ['rebounds','assists','turnovers'],
    home: ['home_away_split','home_court'],
    pace: ['pace_diff','pace_factor','pace_combined'],
  };
  for (const [gn, pats] of Object.entries(groups)) {
    combos.push({ name: `zeroGrp_${gn}`, cat: 'group', mods: pats.map(p=>({market:'all',key:p,action:'zeroGroup'})) });
    combos.push({ name: `2xGrp_${gn}`, cat: 'group', mods: pats.map(p=>({market:'all',key:p,action:'multiplyGroup',value:2})) });
    combos.push({ name: `0.5xGrp_${gn}`, cat: 'group', mods: pats.map(p=>({market:'all',key:p,action:'multiplyGroup',value:0.5})) });
    combos.push({ name: `3xGrp_${gn}`, cat: 'group', mods: pats.map(p=>({market:'all',key:p,action:'multiplyGroup',value:3})) });
  }

  // 5. "Only X" isolation combos
  for (const [gn, pats] of Object.entries(groups)) {
    const others = Object.entries(groups).filter(([n])=>n!==gn).flatMap(([,p])=>p);
    combos.push({ name: `only_${gn}`, cat: 'isolate', mods: others.map(p=>({market:'all',key:p,action:'zeroGroup'})) });
  }

  // 6. Sign flips
  for (const k of ['momentum_diff','trend_diff','recent_form_l1','recent_form_l3'])
    combos.push({ name: `flip_${k}`, cat: 'flip', mods: [{market:'all',key:k,action:'multiplyGroup',value:-1}] });

  // 7. Strategy combos
  combos.push({ name: 'recency_bias', cat: 'strategy', mods: [
    {market:'all',key:'recent_form_l1',action:'multiplyGroup',value:2.5},
    {market:'all',key:'recent_form_l3',action:'multiplyGroup',value:2},
    {market:'all',key:'recent_form_l5',action:'multiplyGroup',value:1.5},
    {market:'all',key:'recent_form_l10',action:'multiplyGroup',value:0.5},
  ]});
  combos.push({ name: 'longterm_trust', cat: 'strategy', mods: [
    {market:'all',key:'recent_form_l1',action:'multiplyGroup',value:0.3},
    {market:'all',key:'recent_form_l3',action:'multiplyGroup',value:0.5},
    {market:'all',key:'recent_form_l5',action:'multiplyGroup',value:1.5},
    {market:'all',key:'recent_form_l10',action:'multiplyGroup',value:2.5},
  ]});
  combos.push({ name: 'fundamentals_only', cat: 'strategy', mods: [
    {market:'all',key:'recent_form',action:'zeroGroup'},{market:'all',key:'momentum',action:'zeroGroup'},
    {market:'all',key:'trend',action:'zeroGroup'},{market:'all',key:'net_rating',action:'multiplyGroup',value:2},
    {market:'all',key:'offensive_rating',action:'multiplyGroup',value:1.5},{market:'all',key:'defensive_rating',action:'multiplyGroup',value:1.5},
  ]});
  combos.push({ name: 'no_injuries', cat: 'strategy', mods: [{market:'all',key:'injury',action:'zeroGroup'}] });
  combos.push({ name: 'defense_heavy', cat: 'strategy', mods: [
    {market:'all',key:'defensive_rating',action:'multiplyGroup',value:2.5},{market:'all',key:'defense_papg',action:'multiplyGroup',value:2},
    {market:'all',key:'opponent_fg',action:'multiplyGroup',value:2},{market:'all',key:'offensive_rating',action:'multiplyGroup',value:0.5},
  ]});
  combos.push({ name: 'offense_heavy', cat: 'strategy', mods: [
    {market:'all',key:'offensive_rating',action:'multiplyGroup',value:2.5},{market:'all',key:'offense_ppg',action:'multiplyGroup',value:2},
    {market:'all',key:'fg_percentage',action:'multiplyGroup',value:2},{market:'all',key:'defensive_rating',action:'multiplyGroup',value:0.5},
  ]});
  combos.push({ name: 'ultra_simple', cat: 'strategy', mods: [
    ...Array.from(allKeys).filter(k=>!k.includes('net_rating')&&!k.includes('point_differential')&&!k.includes('home_court'))
      .map(k=>({market:'all',key:k,action:'zero'}))
  ]});
  combos.push({ name: 'max_injury_3x', cat: 'strategy', mods: [{market:'all',key:'injury',action:'multiplyGroup',value:3}] });
  combos.push({ name: 'turnovers_3x', cat: 'strategy', mods: [{market:'all',key:'turnovers',action:'multiplyGroup',value:3}] });
  combos.push({ name: 'shooting_focus', cat: 'strategy', mods: [
    {market:'all',key:'fg_percentage',action:'multiplyGroup',value:2.5},{market:'all',key:'three_point',action:'multiplyGroup',value:2.5},
  ]});

  // 8. Combined experiments
  combos.push({ name: 'combo_defense_noform', cat: 'combo', mods: [
    {market:'all',key:'defensive_rating',action:'multiplyGroup',value:2},{market:'all',key:'recent_form',action:'zeroGroup'},
    {market:'all',key:'momentum',action:'zeroGroup'},
  ]});
  combos.push({ name: 'combo_ratings_noinjury', cat: 'combo', mods: [
    {market:'all',key:'net_rating',action:'multiplyGroup',value:2.5},{market:'all',key:'offensive_rating',action:'multiplyGroup',value:1.5},
    {market:'all',key:'defensive_rating',action:'multiplyGroup',value:1.5},{market:'all',key:'injury',action:'zeroGroup'},
  ]});
  combos.push({ name: 'combo_simple_plus_def', cat: 'combo', mods: [
    {market:'all',key:'recent_form',action:'zeroGroup'},{market:'all',key:'momentum',action:'zeroGroup'},
    {market:'all',key:'trend',action:'zeroGroup'},{market:'all',key:'rebounds',action:'zeroGroup'},
    {market:'all',key:'assists',action:'zeroGroup'},{market:'all',key:'fg_percentage',action:'zeroGroup'},
    {market:'all',key:'three_point',action:'zeroGroup'},{market:'all',key:'defensive_rating',action:'multiplyGroup',value:2},
  ]});

  // 9. csvDampen variations
  for (const d of [0.10, 0.20, 0.40, 0.50, 0.60, 0.80, 1.00])
    combos.push({ name: `csvDampen_${d}`, cat: 'dampen', csvDampen: d, mods: [] });

  // 10. Market-specific scaling
  for (const m of ['moneyline','spread','total']) {
    for (const s of [0.5, 1.5, 2.0, 3.0]) {
      const mw = refWeights[m] || {};
      combos.push({ name: `${m}_${s}x`, cat: 'mkt_scale', mods:
        Object.keys(mw).filter(k=>!k.startsWith('param_')&&!k.startsWith('score_')).map(k=>({market:m,key:k,action:'multiply',value:s}))
      });
    }
  }

  return combos;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== WEIGHT SWEEP BACKTESTER ===`);
  console.log(`Period: last ${DAYS} days | Top: ${TOP_N}`);
  if (LEAGUE_FILTER) console.log(`League filter: ${LEAGUE_FILTER}`);

  // 1. Load Performance Log (using SHEETS constant for correct tab name)
  console.log('\n[1/6] Loading Performance Log...');
  const perfRows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  if (!perfRows || perfRows.length < 2) throw new Error('No Performance Log data');

  // 2. Parse picks — column indices match backtest-sweep.js (proven to work)
  // Col 0=Date, 1=League, 2=Market, 3=Game, 4=Pick, 9=Odds, 10=Units, 11=Edge, 16=Result
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
    if (LEAGUE_FILTER && league !== LEAGUE_FILTER) continue;

    const market = (row[2] || '').trim().toLowerCase();
    const mappedMarket = market.includes('spread') ? 'spread' : market.includes('total') ? 'total' : 'moneyline';
    const odds = parseInt(String(row[9] || '-110').replace(/[^0-9.\-]/g, '')) || -110;
    const units = parseFloat(String(row[10] || '0').replace(/[^0-9.\-]/g, '')) || 0;
    const edge = parseFloat(String(row[11] || '0').replace(/[^0-9.%\-]/g, '')) || 0;
    const pickText = (row[4] || '').toString();
    const gameTime = (row[5] || '').toString().trim();

    // Try inline feature JSON (col 17+) — same fallback as backtest-sweep
    let features = null;
    for (let c = 17; c < row.length; c++) {
      const cell = String(row[c] || '');
      if (cell.startsWith('{')) {
        try { features = JSON.parse(cell); break; } catch (_) {}
      }
    }

    const m = parseInt(parts[1]), d = parseInt(parts[2]), y = parseInt(parts[3]);
    picks.push({
      date: rawDate,
      dateISO: `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
      league, market: mappedMarket, pick: pickText, actualResult: result,
      odds, units, edge, gameTime, features,
      pickSide: pickText.toLowerCase().includes('over') ? 'over' :
                pickText.toLowerCase().includes('under') ? 'under' :
                pickText.toLowerCase().includes('away') ? 'away' : 'home',
    });
  }
  console.log(`  Loaded ${picks.length} graded picks in ${DAYS}-day window`);
  if (picks.length === 0) { console.log('No picks to analyze — exiting'); return; }

  // 3. Load feature vectors from Supabase
  console.log('\n[2/6] Loading prediction features from Supabase...');
  let featuresLoaded = 0;
  if (db.isEnabled()) {
    try {
      const sb = db.getClient();
      const { data, error } = await sb.from('prediction_features')
        .select('game_id, league, market, features')
        .gte('created_at', cutoff.toISOString());
      if (data && data.length > 0) {
        console.log(`  ${data.length} feature rows from Supabase`);
        // Build lookup by game_id|market
        const fmap = {};
        for (const r of data) {
          if (r.features && typeof r.features === 'object') fmap[`${r.game_id}|${r.market}`] = r.features;
        }
        // Match to picks by gameTime|market
        for (const pick of picks) {
          if (pick.features) continue; // already has inline features
          const key = `${pick.gameTime}|${pick.market}`;
          if (fmap[key]) { pick.features = fmap[key]; featuresLoaded++; }
        }
      }
    } catch (e) { console.log(`  Supabase error: ${e.message}`); }
  }
  const withFeatures = picks.filter(p => p.features && Object.keys(p.features).length > 3);
  console.log(`  Picks with features: ${withFeatures.length}/${picks.length} (${featuresLoaded} from Supabase)`);

  // 4. Load weight sheets
  console.log('\n[3/6] Loading weight sheets...');
  const weightsByLeague = await loadAllWeights();
  for (const [lg, w] of Object.entries(weightsByLeague)) {
    console.log(`  ${lg}: ${Object.keys(w.moneyline || {}).length} ML keys`);
  }

  // 5. Build combos
  console.log('\n[4/6] Building weight combos...');
  const refWeights = weightsByLeague['NBA'] || Object.values(weightsByLeague)[0];
  const combos = buildWeightCombos(refWeights);
  console.log(`  ${combos.length} weight combinations to test`);

  // 6. Run sweep
  console.log('\n[5/6] Running sweep...');
  const useFeatures = withFeatures.length >= 30;
  const simPicks = useFeatures ? withFeatures : picks;
  console.log(`  Mode: ${useFeatures ? 'feature-rescore' : 'result-replay'} (${simPicks.length} picks)`);

  const results = [];

  // Baseline
  const baseline = simulate(simPicks, weightsByLeague, null, 0.30, useFeatures);
  baseline.name = 'BASELINE'; baseline.cat = 'baseline';
  results.push(baseline);

  for (let ci = 0; ci < combos.length; ci++) {
    if ((ci+1) % 50 === 0) console.log(`  Progress: ${ci+1}/${combos.length}`);
    const c = combos[ci];
    const r = simulate(simPicks, weightsByLeague, c.mods, c.csvDampen || 0.30, useFeatures);
    r.name = c.name; r.cat = c.cat;
    results.push(r);
  }

  // Sort by win rate (primary) then ROI
  results.sort((a,b) => b.winRate - a.winRate || b.roi - a.roi);

  // 7. Display results
  console.log(`\n=== TOP ${TOP_N} WEIGHT CONFIGURATIONS (by win rate) ===`);
  console.log(`${'#'.padEnd(4)} ${'Name'.padEnd(40)} ${'Cat'.padEnd(12)} ${'W-L'.padEnd(10)} ${'Win%'.padEnd(7)} ${'ROI'.padEnd(8)} ${'Units'.padEnd(10)} ${'vs Base'.padEnd(8)}`);
  console.log('-'.repeat(100));
  for (let i = 0; i < Math.min(TOP_N, results.length); i++) {
    const r = results[i];
    const diff = (r.winRate - baseline.winRate).toFixed(1);
    console.log(
      `${(i+1+'.').padEnd(4)} ${r.name.padEnd(40)} ${(r.cat||'').padEnd(12)} `+
      `${(r.wins+'-'+r.losses).padEnd(10)} ${(r.winRate+'%').padEnd(7)} ${(r.roi+'%').padEnd(8)} `+
      `${r.totalReturn.padEnd(10)} ${diff >= 0 ? '+' : ''}${diff}%`
    );
  }

  const baseRank = results.indexOf(baseline) + 1;
  console.log('-'.repeat(100));
  console.log(`BASELINE rank: #${baseRank}/${results.length} | ${baseline.wins}-${baseline.losses} | ${baseline.winRate}% | ${baseline.totalReturn} units | ROI ${baseline.roi}%`);

  // League breakdown for top 5
  console.log('\n=== TOP 5 LEAGUE BREAKDOWN ===');
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    console.log(`\n${i+1}. ${r.name} (Win%: ${r.winRate}%, ROI: ${r.roi}%)`);
    for (const [lg, lr] of Object.entries(r.byLeague || {})) {
      const t = lr.w + lr.l;
      console.log(`   ${lg}: ${lr.w}-${lr.l} (${t>0?(lr.w/t*100).toFixed(1):'0'}%) → ${lr.ret.toFixed(2)}u`);
    }
  }

  // Noise features
  const noiseFeatures = results.filter(r => r.cat === 'zero' && r.winRate >= baseline.winRate)
    .map(r => ({ feat: r.name.replace('zero_',''), wr: r.winRate, diff: (r.winRate - baseline.winRate).toFixed(1) }));
  if (noiseFeatures.length > 0) {
    console.log(`\n=== NOISE FEATURES (zeroing helps or neutral) ===`);
    for (const nf of noiseFeatures.slice(0,15))
      console.log(`  ${nf.feat}: ${nf.wr}% (${nf.diff >= 0 ? '+' : ''}${nf.diff}% vs baseline)`);
  }

  // Save
  const outputDir = path.join(__dirname, '..', 'weight-reviews');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outFile = path.join(outputDir, `weight-sweep-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    runDate: new Date().toISOString(), days: DAYS, league: LEAGUE_FILTER,
    totalPicks: picks.length, withFeatures: withFeatures.length,
    mode: useFeatures ? 'feature-rescore' : 'result-replay',
    combos: combos.length, baselineRank: baseRank,
    baseline, top30: results.slice(0,30), noiseFeatures,
    allResults: results,
  }, null, 2));
  console.log(`\nResults saved to: ${outFile}`);

  // Recommendations
  console.log('\n=== RECOMMENDATIONS ===');
  const better = results.filter(r => r.winRate > baseline.winRate && r.cat !== 'baseline');
  console.log(`${better.length} configs beat baseline win rate of ${baseline.winRate}%`);
  if (better.length > 0) {
    console.log(`Best: "${better[0].name}" → ${better[0].winRate}% (+${(better[0].winRate - baseline.winRate).toFixed(1)}%)`);
  }
}

// ── Simulation engine ───────────────────────────────────────────
function simulate(picks, weightsByLeague, mods, csvDampen, useFeatures) {
  let wins = 0, losses = 0, totalReturn = 0;
  const byLeague = {};

  for (const pick of picks) {
    const lg = pick.league;
    if (!byLeague[lg]) byLeague[lg] = { w:0, l:0, ret:0 };

    let wouldWin;
    if (useFeatures && pick.features) {
      // Re-score with modified weights to see if prediction direction changes
      const baseW = weightsByLeague[lg] || weightsByLeague['NBA'];
      const modW = mods && mods.length > 0 ? modifyWeights(baseW, mods) : baseW;

      const baseScore = scoreMarket(pick.features, baseW[pick.market] || {});
      const modScore = scoreMarket(pick.features, modW[pick.market] || {});

      // If mod score has same sign as base score, we'd make the same pick → same result
      // If mod score flips sign, we'd pick the opposite → flip result
      if (Math.sign(modScore) === Math.sign(baseScore) || baseScore === 0) {
        wouldWin = pick.actualResult === 'W';
      } else {
        wouldWin = pick.actualResult === 'L'; // flipped
      }
    } else {
      wouldWin = pick.actualResult === 'W';
    }

    const odds = pick.odds;
    const u = pick.units || 0.10;
    if (wouldWin) {
      wins++;
      const pay = odds > 0 ? u * (odds/100) : u * (100/Math.abs(odds));
      totalReturn += pay;
      byLeague[lg].w++; byLeague[lg].ret += pay;
    } else {
      losses++;
      totalReturn -= u;
      byLeague[lg].l++; byLeague[lg].ret -= u;
    }
  }

  const total = wins + losses;
  return {
    wins, losses,
    winRate: total > 0 ? (wins/total*100).toFixed(1) : '0.0',
    totalReturn: totalReturn.toFixed(2),
    roi: total > 0 ? (totalReturn/(total*0.10)*100).toFixed(1) : '0.0',
    byLeague,
  };
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
