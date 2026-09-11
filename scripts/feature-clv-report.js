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
// ── TWO DEFECTS FIXED 2026-09-10, both of which inflated the numbers ─────────
//
// 1. ROW CAP. This asked for `.limit(20000)`, but PostgREST caps a response at
//    1000 rows regardless of what the client requests. The ledger already held
//    1528 matching rows, so the 2026-09-06 report ("815 vectors, 227 games")
//    was computed on roughly 40% of the data, silently, with no error. Every
//    read here now pages with `.range()` and reports how many rows it actually
//    got, so a truncated read can never again look like a complete one.
//
// 2. SCHEMA CHANGE MID-SAMPLE. On 2026-08-31 `top_contributions` changed from
//    the top 5 features to all 27. Those two shapes are not comparable:
//
//      - Before, a feature only appears in a game when it ranked top-5, i.e.
//        the sample is selected on the very magnitude we then correlate.
//      - After, every feature appears in every game, so all features share one
//        identical game set and one identical mean CLV.
//
//    Pooling them is what made run_differential_diff read t=3.64 against a
//    3.291 bar. Split, it is t=1.85 before and t=3.91 after — the "signal" was
//    the join between two regimes. This script now REFUSES to pool them and
//    reports each era separately. Default `--since` is the schema-change date,
//    so the default report is the clean regime only.
//
// A caveat that no split fixes: the features are heavily collinear
// (run_differential_diff vs whip_diff, r=0.888 post-8/31). 27 features are not
// 27 independent tests, so the Bonferroni threshold here is conservative in
// count but the underlying dimensionality is closer to 2-3. Treat a single
// feature clearing the bar as a hypothesis to pre-register, never as a result.
//
// Usage: node scripts/feature-clv-report.js [--league MLB] [--since 2026-08-31]
// =============================================================

const fs = require('fs');
const path = require('path');
const { attributeByFeature, collinearityClusters } = require('../src/feature-clv');
const db = require('../src/db');

const OUT_DIR = path.join(__dirname, '..', 'feature-clv-reports');

// The day top_contributions went from top-5 to all-27. Rows on or after this
// date are the only ones where "this feature did not push this game" is
// actually recorded rather than merely absent.
const CONTRIB_SCHEMA_CHANGE = '2026-08-31';

// PostgREST's server-side ceiling. Pages are requested at exactly this size so
// a short page is an unambiguous end-of-data signal.
const PAGE = 1000;

function fmt(v, d = 3, sign = false) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${sign && v >= 0 ? '+' : ''}${v.toFixed(d)}`;
}

/**
 * Read every matching row, not the first 1000.
 *
 * `build()` must return a FRESH query builder each call — a supabase-js
 * builder is single-use and cannot be re-awaited with a new range.
 */
async function fetchAll(build, label) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data || [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** Collapse joined rows into the {gameKey, feature, contribution, clv} shape. */
function buildRows(feats, byPickId) {
  const rows = [];
  let joined = 0;
  for (const f of feats) {
    const led = byPickId.get(f.pick_id);
    if (!led || !led.game_key) continue;
    joined++;
    for (const c of (f.top_contributions || [])) {
      if (!c || !c.feature) continue;
      rows.push({ gameKey: led.game_key, feature: c.feature,
                  contribution: Number(c.contribution), clv: Number(led.clv_prob_delta),
                  candidate: c.candidate === true });
    }
  }
  return { rows, joined };
}

/** One era's table. Returns markdown. */
function renderEra(title, note, rows, joined) {
  const { features, nFeatures, tThreshold } = attributeByFeature(rows, { minGames: 30 });
  const games = new Set(rows.map(r => r.gameKey)).size;

  let md = `## ${title}\n\n${note}\n\n`;
  md += `**${joined}** feature vectors joined to a measured CLV across **${games}** distinct `;
  md += `games. ${nFeatures} feature(s) had enough games to test. Significance at `;
  md += `|t| ≥ **${tThreshold.toFixed(3)}**, Bonferroni-corrected for ${nFeatures} feature(s).\n\n`;

  if (!rows.length) return `${md}_No data in this era._\n\n`;

  const hits = features.filter(f => f.significant);
  md += hits.length
    ? `**${hits.length} feature(s) clear the bar.** Pre-register before acting — see the header of this script on collinearity.\n\n`
    : `Nothing clears the bar. That is the expected result at this sample size, not a failure.\n\n`;

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
  return `${md}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const li = args.indexOf('--league');
  const league = li >= 0 ? args[li + 1] : 'MLB';
  const si = args.indexOf('--since');
  const since = si >= 0 ? args[si + 1] : CONTRIB_SCHEMA_CHANGE;

  if (!db.isEnabled()) { console.error('[feature-clv] Supabase required.'); process.exit(1); }
  const sb = db.getClient();

  const ledger = await fetchAll(() => sb.from('performance_log')
    .select('pick_id, game_key, clv_prob_delta, market')
    .eq('pick_regime', 'v2_clv').eq('league', league).eq('clv_basis', 'novig')
    .not('clv_prob_delta', 'is', null).gte('game_date', since)
    .order('pick_id', { ascending: true }), 'performance_log');

  const byPickId = new Map();
  for (const r of ledger) if (r.pick_id) byPickId.set(r.pick_id, r);

  const feats = await fetchAll(() => sb.from('prediction_features')
    .select('pick_id, date, top_contributions').eq('league', league)
    .not('pick_id', 'is', null).gte('date', since)
    .order('pick_id', { ascending: true }), 'prediction_features');

  console.log(`[feature-clv] read ${ledger.length} ledger rows, ${feats.length} feature rows`);

  // Split on the schema change. Never pooled — see the header.
  const older = feats.filter(f => String(f.date) < CONTRIB_SCHEMA_CHANGE);
  const newer = feats.filter(f => String(f.date) >= CONTRIB_SCHEMA_CHANGE);

  let md = `# Feature → CLV attribution — ${league} — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `Since ${since}. Read ${ledger.length} ledger rows and ${feats.length} feature rows `;
  md += `(paged — this report was truncated to 1000 rows apiece before 2026-09-10).\n\n`;
  md += `Every figure is **clustered by game** — a game's moneyline, spread and total pick share `;
  md += `one model state and one line move, so they are one observation, not three.\n\n`;
  md += `> **The two eras below are not comparable and are never pooled.** On `;
  md += `${CONTRIB_SCHEMA_CHANGE} \`top_contributions\` changed from the top 5 features to all 27. `;
  md += `Before that date a feature is only present when it ranked top-5, which selects on the `;
  md += `same magnitude being correlated; after it, every feature is present in every game. `;
  md += `Pooling the two is what made run_differential_diff read t=3.64 on 2026-09-10.\n\n`;

  const newBuilt = buildRows(newer, byPickId);
  // Candidates: declared, computed, weighted 0, staked on nothing. Kept out of
  // the live table and given their own multiplicity correction — pooling them
  // would both raise the bar for the live features and let a candidate read as
  // though it were already earning its keep.
  const liveRows = newBuilt.rows.filter(r => !r.candidate);
  const candRows = newBuilt.rows.filter(r => r.candidate);
  const oldBuilt = buildRows(older, byPickId);

  md += renderEra(
    `Clean regime — on/after ${CONTRIB_SCHEMA_CHANGE} (all 27 features recorded)`,
    'This is the era to trust. Every feature is present in every game, so absence is recorded rather than inferred.',
    liveRows, newBuilt.joined);

  if (candRows.length) {
    md += renderEra(
      'Candidate features — weighted 0, staked on nothing',
      'These move no pick. They are logged so a weight can be justified BEFORE it is given, rather than by giving it one and seeing what happens. A candidate clearing the bar is a pre-registration, not a promotion.',
      candRows, new Set(candRows.map(r => r.gameKey)).size);
  }

  // Collinearity, on the clean era only — the legacy top-5 shape cannot support
  // it (two features are only ever compared on games where BOTH ranked top-5).
  const col = collinearityClusters(liveRows, { minGames: 30, threshold: 0.7 });
  if (col.nFeatures) {
    md += `## How many features are there really?\n\n`;
    md += `${col.nFeatures} testable features collapse into **${col.effectiveFeatures} independent `;
    md += `group(s)** at |r| ≥ ${col.threshold}. Weights inside one group cannot be tuned against `;
    md += `each other — raising one and lowering another is a no-op. Treat a group as one dial.\n\n`;
    for (const c of col.clusters) {
      md += c.length > 1 ? `- **${c.length} together:** ${c.join(', ')}\n` : `- _alone:_ ${c[0]}\n`;
    }
    if (col.pairs.length) {
      md += `\nTightest pairings:\n\n| A | B | r |\n|---|---|---|\n`;
      for (const pr of col.pairs.slice(0, 8)) {
        md += `| ${pr.a} | ${pr.b} | ${fmt(pr.r, 3, true)} |\n`;
      }
    }
    md += `\n`;
  }

  if (oldBuilt.rows.length) {
    md += renderEra(
      `Legacy regime — before ${CONTRIB_SCHEMA_CHANGE} (top 5 features only)`,
      'Shown for completeness only. Every r here is biased by top-5 selection; do not compare it to the table above and do not act on it.',
      oldBuilt.rows, oldBuilt.joined);
  }

  md += `**How to read this.** A positive r means: the more this feature pushed the pick, the `;
  md += `better the price we got relative to the close. That is the earliest available evidence `;
  md += `a weight deserves to go up. Do not act on a row marked "not resolvable yet" — at ~19 `;
  md += `features, the best of them clears t=2.5 by chance most weeks. And because the features `;
  md += `are collinear (run_differential_diff vs whip_diff, r=0.888), a single feature clearing `;
  md += `the bar is a hypothesis to pre-register and measure forward, not a result.\n`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-${league}.md`);
  fs.writeFileSync(out, md);
  console.log(md);
  console.log(`[feature-clv] wrote ${out}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, fetchAll, buildRows, CONTRIB_SCHEMA_CHANGE };
