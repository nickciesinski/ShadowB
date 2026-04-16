#!/usr/bin/env node
'use strict';
/**
 * scripts/export-weight-analysis.js
 *
 * Generates a weekly weight-tuning analysis report for Claude Cowork.
 *
 * Produces two files in the repo root (./weight-reviews/):
 *   1. <YYYY-MM-DD>-analysis.md  — human + Cowork-readable report with:
 *        · Current weights per league (CSV dump)
 *        · 7-day and 30-day performance by league|market (from Supabase)
 *        · Current PERFORMANCE_MODIFIERS from predictions.js
 *        · Flagged markets (hot, cold, suppressed)
 *        · Suggested tuning directions (not decisions)
 *   2. <YYYY-MM-DD>-context.json — same data in structured form so a
 *      Cowork scheduled task can parse it programmatically.
 *
 * Cowork loop:
 *   1. Sunday morning scheduled task runs this script
 *   2. Task reads the .md + .json, decides weight changes
 *   3. Task edits weights/Weights_<LEAGUE>.csv with proposed values
 *   4. Task pings user to review diff + run apply-weights workflow
 *
 * Usage:
 *   node scripts/export-weight-analysis.js
 *   node scripts/export-weight-analysis.js --days 14
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const LEAGUES = ['MLB', 'NBA', 'NHL', 'NFL'];
const OUT_DIR = path.join(__dirname, '..', 'weight-reviews');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Read a weights CSV from the repo (source of truth for Weights_* sheets). */
function readWeightsCsv(league) {
  const p = path.join(__dirname, '..', 'weights', `Weights_${league}.csv`);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const [header, ...rest] = lines;
  const rows = rest.map(l => {
    const [market, key, weight] = l.split(',');
    return { market: (market || '').trim(), key: (key || '').trim(), weight: parseFloat(weight) };
  });
  return { header, rows };
}

/** Query Supabase for league|market performance in a rolling window. */
async function getPerformance(days) {
  if (!db.isEnabled()) return null;
  const sb = db.getClient();
  const cutoff = dateNDaysAgo(days);
  const { data, error } = await sb
    .from('performance_log')
    .select('league, market, result, final_units, unit_return, clv_grade')
    .gte('date', cutoff);
  if (error) { console.warn('[export] performance query failed:', error.message); return null; }

  const agg = {};
  for (const r of data || []) {
    const key = `${r.league}|${r.market}`;
    if (!agg[key]) agg[key] = {
      league: r.league, market: r.market,
      n: 0, wins: 0, losses: 0, pushes: 0,
      stakedUnits: 0, returnUnits: 0,
      clvGood: 0, clvBad: 0, clvFlat: 0, clvGraded: 0,
    };
    const a = agg[key];
    a.n++;
    const res = String(r.result || '').toUpperCase();
    if (res === 'W' || res === 'WIN') a.wins++;
    else if (res === 'L' || res === 'LOSS') a.losses++;
    else if (res === 'P' || res === 'PUSH') a.pushes++;
    a.stakedUnits += parseFloat(r.final_units) || 0;
    a.returnUnits += parseFloat(r.unit_return) || 0;
    if (r.clv_grade) {
      a.clvGraded++;
      if (r.clv_grade === 'GOOD') a.clvGood++;
      else if (r.clv_grade === 'BAD') a.clvBad++;
      else a.clvFlat++;
    }
  }
  for (const k of Object.keys(agg)) {
    const a = agg[k];
    const decided = a.wins + a.losses;
    a.winRate = decided ? (a.wins / decided) * 100 : null;
    a.roi = a.stakedUnits ? (a.returnUnits / a.stakedUnits) * 100 : null;
    a.clvGoodPct = a.clvGraded ? (a.clvGood / a.clvGraded) * 100 : null;
  }
  return agg;
}

/** Pull PERFORMANCE_MODIFIERS map from predictions.js (regex; avoids requiring secrets). */
function readModifiers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'predictions.js'), 'utf8');
  const block = src.match(/PERFORMANCE_MODIFIERS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return {};
  const out = {};
  const lineRe = /['"]([A-Z]+\|[a-z]+)['"]\s*:\s*([\d.]+)/g;
  let m;
  while ((m = lineRe.exec(block[1])) !== null) {
    out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

function flagSuggestion(perf) {
  if (!perf) return '—';
  const { winRate, roi, clvGoodPct, n } = perf;
  if (n < 20) return `hold (n=${n}, insufficient sample)`;
  if (roi > 8 && winRate > 52) return `BOOST — strong: ${roi.toFixed(1)}% ROI, ${winRate.toFixed(1)}% win`;
  if (roi > 3 && winRate > 50) return `slight boost — ${roi.toFixed(1)}% ROI, ${winRate.toFixed(1)}% win`;
  if (roi < -8) return `HARD CUT — bleeding: ${roi.toFixed(1)}% ROI`;
  if (roi < -3 && winRate < 50) return `cut — ${roi.toFixed(1)}% ROI, ${winRate.toFixed(1)}% win`;
  if (clvGoodPct !== null && clvGoodPct < 40) return `CLV penalty — only ${clvGoodPct.toFixed(0)}% good CLV`;
  return `hold — ${roi != null ? roi.toFixed(1) + '% ROI' : 'no ROI'}, ${winRate != null ? winRate.toFixed(1) + '% win' : 'no result data'}`;
}

function renderPerfTable(title, perf) {
  if (!perf || Object.keys(perf).length === 0) {
    return `### ${title}\n\n_No data available_\n`;
  }
  const rows = Object.values(perf).sort((a, b) =>
    a.league === b.league ? a.market.localeCompare(b.market) : a.league.localeCompare(b.league));
  let out = `### ${title}\n\n`;
  out += '| League | Market | n | W-L-P | Win% | ROI% | CLV Good% | Suggestion |\n';
  out += '|--------|--------|---|-------|------|------|-----------|------------|\n';
  for (const r of rows) {
    out += `| ${r.league} | ${r.market} | ${r.n} | ${r.wins}-${r.losses}-${r.pushes} `
         + `| ${r.winRate != null ? r.winRate.toFixed(1) : '—'} `
         + `| ${r.roi != null ? r.roi.toFixed(1) : '—'} `
         + `| ${r.clvGoodPct != null ? r.clvGoodPct.toFixed(0) : '—'} `
         + `| ${flagSuggestion(r)} |\n`;
  }
  return out + '\n';
}

function renderWeightsBlock(league) {
  const csv = readWeightsCsv(league);
  if (!csv) return `### ${league}\n\n_weights/Weights_${league}.csv not found_\n`;
  let out = `### ${league} — current weights (\`weights/Weights_${league}.csv\`)\n\n`;
  out += '```csv\n' + csv.header + '\n';
  for (const r of csv.rows) {
    const market = r.market || '';
    out += `${market},${r.key},${r.weight}\n`;
  }
  out += '```\n\n';
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const daysIdx = argv.indexOf('--days');
  const customDays = daysIdx >= 0 ? parseInt(argv[daysIdx + 1]) : null;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[export] Querying performance data...');
  const perf7 = await getPerformance(customDays || 7);
  const perf30 = await getPerformance(30);
  const modifiers = readModifiers();

  const stamp = today();
  const mdPath = path.join(OUT_DIR, `${stamp}-analysis.md`);
  const jsonPath = path.join(OUT_DIR, `${stamp}-context.json`);

  // ── Markdown report ──────────────────────────────────────────
  let md = '';
  md += `# Shadow Bets — Weekly Weight Analysis\n\n`;
  md += `**Generated:** ${new Date().toISOString()}\n`;
  md += `**Window:** last ${customDays || 7} days (primary) and 30 days (trend)\n\n`;
  md += `This report is the input for the weekly Cowork weight-tuning task. Each league has current weight coefficients (from \`weights/Weights_<LEAGUE>.csv\`) followed by recent performance. Use the "Suggestion" column as a starting point — decisions should consider sample size, variance, and trend (7d vs 30d).\n\n`;
  md += `## How to apply proposed changes\n\n`;
  md += `1. Edit \`weights/Weights_<LEAGUE>.csv\` directly with new values\n`;
  md += `2. Commit to main — GitHub will diff it for review\n`;
  md += `3. Run workflow \`apply-weights.yml\` (or \`node scripts/apply-weights.js\` locally) to push to Google Sheets\n`;
  md += `4. For \`PERFORMANCE_MODIFIERS\` changes, edit \`src/predictions.js\` directly (hardcoded map near line 100)\n\n`;

  md += `## Tuning guardrails\n\n`;
  md += `- Weight coefficients: keep within \`0.0 – 5.0\` range; most live in \`0.1 – 2.0\`\n`;
  md += `- \`param_min_units_to_bet\`: floor on any bet; typical \`0.01\`\n`;
  md += `- \`param_max_unit_size\`: ceiling; typical \`3.0\`\n`;
  md += `- \`param_confidence_power\`: curve steepness; typical \`1.4 – 1.8\`\n`;
  md += `- \`PERFORMANCE_MODIFIERS\` (predictions.js): keep within \`0.3 – 1.5\`\n`;
  md += `- Don't change more than ~15% per week per coefficient; compounding weekly moves beats swings\n`;
  md += `- Require \`n ≥ 20\` before adjusting; otherwise hold\n\n`;

  md += `## Current PERFORMANCE_MODIFIERS (stake multipliers)\n\n`;
  md += '| League\\|Market | Modifier |\n|---|---|\n';
  for (const [k, v] of Object.entries(modifiers)) {
    md += `| ${k} | ${v} |\n`;
  }
  md += '\n';

  md += `## Performance\n\n`;
  md += renderPerfTable(`Last ${customDays || 7} days`, perf7);
  md += renderPerfTable(`Last 30 days`, perf30);

  md += `## Current weights\n\n`;
  for (const L of LEAGUES) md += renderWeightsBlock(L);

  fs.writeFileSync(mdPath, md);
  console.log(`[export] Wrote ${mdPath}`);

  // ── JSON context (programmatic parsing) ──────────────────────
  const ctx = {
    generated_at: new Date().toISOString(),
    window_primary_days: customDays || 7,
    performance_modifiers: modifiers,
    performance_7d: perf7 || {},
    performance_30d: perf30 || {},
    weights: Object.fromEntries(LEAGUES.map(L => [L, readWeightsCsv(L)])),
    guardrails: {
      weight_min: 0.0, weight_max: 5.0,
      modifier_min: 0.3, modifier_max: 1.5,
      max_weekly_delta_pct: 15,
      min_sample_size: 20,
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(ctx, null, 2));
  console.log(`[export] Wrote ${jsonPath}`);
  console.log(`\n[export] Next: Cowork task reads ${mdPath} and proposes changes.`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
