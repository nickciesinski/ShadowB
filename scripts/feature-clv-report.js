'use strict';
// =============================================================
// scripts/feature-clv-report.js
//
// "Which variable is actually correlated with a positive result?"
//
// Answered against CLV, clustered by game, corrected for the number of
// features tested. See src/feature-clv.js for why each of those three
// choices is load-bearing.
//
// Reports what is NOT yet resolvable as prominently as what is, and how many
// more games each answer needs. On 2026-08-31, one pass through this data
// WITHOUT clustering reported run_differential_diff at t=4.04 and would have
// justified reweighting the model. Clustered, it is t=1.58 — nothing yet.
//
// Usage: node scripts/feature-clv-report.js [--league MLB] [--since 2026-07-31]
// =============================================================

const fs = require('fs');
const path = require('path');
const { attributeByFeature } = require('../src/feature-clv');
const db = require('../src/db');

const OUT_DIR = path.join(__dirname, '..', 'feature-clv-reports');

function fmt(v, d = 3, sign = false) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${sign && v >= 0 ? '+' : ''}${v.toFixed(d)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const li = args.indexOf('--league');
  const league = li >= 0 ? args[li + 1] : 'MLB';
  const si = args.indexOf('--since');
  const since = si >= 0 ? args[si + 1] : '2026-07-31';

  if (!db.isEnabled()) { console.error('[feature-clv] Supabase required.'); process.exit(1); }
  const sb = db.getClient();

  // Ledger side: the measured CLV, keyed by pick_id and grouped by game.
  const { data: ledger, error: e1 } = await sb.from('performance_log')
    .select('pick_id, game_key, clv_prob_delta, market')
    .eq('pick_regime', 'v2_clv').eq('league', league).eq('clv_basis', 'novig')
    .not('clv_prob_delta', 'is', null).gte('game_date', since).limit(20000);
  if (e1) { console.error('[feature-clv]', e1.message); process.exit(1); }

  const byPickId = new Map();
  for (const r of ledger || []) if (r.pick_id) byPickId.set(r.pick_id, r);

  // Feature side.
  const { data: feats, error: e2 } = await sb.from('prediction_features')
    .select('pick_id, top_contributions').eq('league', league)
    .not('pick_id', 'is', null).gte('date', since).limit(20000);
  if (e2) { console.error('[feature-clv]', e2.message); process.exit(1); }

  const rows = [];
  let joined = 0;
  for (const f of feats || []) {
    const led = byPickId.get(f.pick_id);
    if (!led || !led.game_key) continue;
    joined++;
    for (const c of (f.top_contributions || [])) {
      if (!c || !c.feature) continue;
      rows.push({ gameKey: led.game_key, feature: c.feature,
                  contribution: Number(c.contribution), clv: Number(led.clv_prob_delta) });
    }
  }

  const { features, nFeatures, tThreshold } = attributeByFeature(rows, { minGames: 30 });
  const games = new Set(rows.map(r => r.gameKey)).size;

  let md = `# Feature → CLV attribution — ${league} — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `Since ${since}. **${joined}** feature vectors joined to a measured CLV across `;
  md += `**${games}** distinct games. ${nFeatures} feature(s) had enough games to test.\n\n`;
  md += `Every figure is **clustered by game** — a game's moneyline, spread and total pick share `;
  md += `one model state and one line move, so they are one observation, not three. `;
  md += `Significance is judged at |t| ≥ **${tThreshold.toFixed(3)}**, Bonferroni-corrected for `;
  md += `${nFeatures} feature(s) tested.\n\n`;

  const hits = features.filter(f => f.significant);
  md += hits.length
    ? `## ${hits.length} feature(s) clear the bar\n\n`
    : `## Nothing clears the bar yet\n\nThat is the expected result at this sample size, not a failure. The table says how much more is needed.\n\n`;

  md += `| Feature | Games | r vs CLV | t | Mean CLV | Verdict | Games needed |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const f of features) {
    const verdict = !f.resolvable ? 'too thin'
      : f.significant ? (f.r > 0 ? '**EARNING ITS WEIGHT**' : '**HURTING**')
      : 'not resolvable yet';
    const need = f.significant ? '—'
      : f.shortBy ? `${f.gamesNeeded} (${f.shortBy} more)` : '—';
    md += `| ${f.feature} | ${f.nGames} | ${fmt(f.r, 4, true)} | ${fmt(f.t, 2, true)} | `
        + `${fmt(f.meanClvPp, 3, true)}pp | ${verdict} | ${need} |\n`;
  }
  md += `\n**How to read this.** A positive r means: the more this feature pushed the pick, the `;
  md += `better the price we got relative to the close. That is the earliest available evidence `;
  md += `a weight deserves to go up. Do not act on a row marked "not resolvable yet" — at ~19 `;
  md += `features, the best of them clears t=2.5 by chance most weeks.\n`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-${league}.md`);
  fs.writeFileSync(out, md);
  console.log(md);
  console.log(`[feature-clv] wrote ${out}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
