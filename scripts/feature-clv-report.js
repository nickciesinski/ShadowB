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
const {
  attributeByFeature, collinearityClusters, marketGroup, pickSign, lockTimeVectors,
  bundleTest, frozenComposite,
} = require('../src/feature-clv');
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

/**
 * Collapse joined rows into the {gameKey, feature, contribution, clv} shape.
 *
 * 2026-10-01: `contribution` is turned to the PICKED side (see src/feature-clv.js
 * pickSign) and each row carries its market group, so sides and totals are never
 * pooled. A pick whose side cannot be read is dropped and counted, not guessed.
 */
function buildRows(feats, byPickId) {
  const rows = [];
  let joined = 0, unsided = 0;
  for (const f of feats) {
    const led = byPickId.get(f.pick_id);
    if (!led || !led.game_key) continue;
    const sign = pickSign(led);
    if (sign === null) { unsided++; continue; }
    joined++;
    const group = marketGroup(led.market);
    for (const c of (f.top_contributions || [])) {
      if (!c || !c.feature) continue;
      rows.push({ gameKey: led.game_key, pickId: f.pick_id, gameDate: led.game_date, group,
                  feature: c.feature, contribution: Number(c.contribution) * sign,
                  clv: Number(led.clv_prob_delta), candidate: c.candidate === true });
    }
  }
  return { rows, joined, unsided };
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

/** The candidates tested as one bundle. Returns markdown. */
function renderBundle(rows) {
  const b = bundleTest(rows, { perms: 2000 });
  let md = `### All candidates as one bundle\n\n`;
  if (!b.resolvable) return `${md}_${b.nGames} game(s) — too few to test._\n\n`;
  md += `One test instead of ${b.nFeatures}: game-level CLV shuffled ${b.perms}x across `;
  md += `${b.nGames} games. Shuffling keeps the features' overlap with each other, so this needs no `;
  md += `extra multiple-comparison correction.\n\n`;
  md += `| Statistic | Value | p (share of shuffles this large) |\n|---|---|---|\n`;
  md += `| Σr² — many small effects | ${fmt(b.sumR2, 3)} | ${fmt(b.pSumR2, 3)} |\n`;
  md += `| max \\|r\\| — one standout | ${fmt(b.maxAbsR, 3)} | ${fmt(b.pMaxR, 3)} |\n\n`;
  md += b.pSumR2 < 0.05 || b.pMaxR < 0.05
    ? `**The bundle beats noise in-sample.** That earns a pre-registered forward test, never a weight.\n\n`
    : `The bundle is indistinguishable from noise.\n\n`;
  return md;
}

/**
 * Forward scorecards for pre-registered composites (config/prereg-*.json).
 * Only games on/after the registration's start date count — the sample that
 * suggested the weights can never be used to confirm them.
 */
function renderPreregistrations(league, candRows) {
  let md = '';
  const dir = path.join(__dirname, '..', 'config');
  for (const file of fs.readdirSync(dir).filter(f => /^prereg-.*\.json$/.test(f)).sort()) {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (reg.league !== league || reg.marketGroup !== 'sides') continue;
    const end = reg.window.end || '9999-12-31';
    const fwd = candRows.filter(r => r.gameDate >= reg.window.start && r.gameDate <= end);
    const s = frozenComposite(fwd, reg.weights);
    md += `## Pre-registered: ${reg.name}\n\n`;
    md += `Weights frozen ${reg.registered} (\`config/${file}\`). Forward games since `;
    md += `${reg.window.start}: **${s.nGames} / ${reg.test.targetGames}**. `;
    if (s.nGames < reg.test.targetGames) {
      md += `Not scored yet — reading it early is the in-sample mistake this exists to avoid.`;
      md += `\n\n`;
    } else {
      const pass = s.t !== null && s.t > reg.test.tThreshold;
      md += `r=${fmt(s.r, 3, true)}, t=${fmt(s.t, 2, true)} against a bar of t>${reg.test.tThreshold}. `;
      md += pass ? `**PASSED** — see the registration for what that does and does not allow.\n\n`
                 : `**FAILED** — the in-sample result did not hold forward.\n\n`;
    }
  }
  return md;
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
    .select('pick_id, game_key, game_date, clv_prob_delta, market, pick, home_team, away_team, locked_at')
    .eq('pick_regime', 'v2_clv').eq('league', league).eq('clv_basis', 'novig')
    .not('clv_prob_delta', 'is', null).gte('game_date', since)
    .order('pick_id', { ascending: true }), 'performance_log');

  const byPickId = new Map();
  for (const r of ledger) if (r.pick_id) byPickId.set(r.pick_id, r);

  const feats = await fetchAll(() => sb.from('prediction_features')
    .select('pick_id, date, created_at, top_contributions').eq('league', league)
    .not('pick_id', 'is', null).gte('date', since)
    .order('pick_id', { ascending: true }), 'prediction_features');

  console.log(`[feature-clv] read ${ledger.length} ledger rows, ${feats.length} feature rows`);

  // One vector per pick - the one that existed when the price locked. Later
  // re-scores carry information the locked price did not have.
  const { vectors, dropped } = lockTimeVectors(feats, byPickId);

  // Split on the schema change. Never pooled — see the header.
  const older = vectors.filter(f => String(f.date) < CONTRIB_SCHEMA_CHANGE);
  const newer = vectors.filter(f => String(f.date) >= CONTRIB_SCHEMA_CHANGE);

  let md = `# Feature → CLV attribution — ${league} — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `Since ${since}. Read ${ledger.length} ledger rows and ${feats.length} feature rows `;
  md += `(paged — this report was truncated to 1000 rows apiece before 2026-09-10). `;
  md += `Kept **${vectors.length}** lock-time vectors, one per pick; **${dropped}** pick(s) had only `;
  md += `vectors written after their price locked and are excluded.\n\n`;
  md += `Every figure is **clustered by game** and every value is turned to **the side we picked** `;
  md += `(positive = the feature favoured our pick). Sides (moneyline + spread) and totals are `;
  md += `reported separately — a home-minus-away difference says nothing about over vs under. `;
  md += `Reports before 2026-10-01 did none of the last three and understated real effects `;
  md += `(starter_ip_l3_diff: t=+0.26 then, t=+3.49 corrected).\n\n`;
  md += `> **The two eras below are not comparable and are never pooled.** On `;
  md += `${CONTRIB_SCHEMA_CHANGE} \`top_contributions\` changed from the top 5 features to all 27. `;
  md += `Before that date a feature is only present when it ranked top-5, which selects on the `;
  md += `same magnitude being correlated; after it, every feature is present in every game. `;
  md += `Pooling the two is what made run_differential_diff read t=3.64 on 2026-09-10.\n\n`;

  const newBuilt = buildRows(newer, byPickId);
  const oldBuilt = buildRows(older, byPickId);
  if (newBuilt.unsided + oldBuilt.unsided) {
    md += `_${newBuilt.unsided + oldBuilt.unsided} pick(s) dropped: side could not be read from the pick text._\n\n`;
  }

  const groups = [
    ['sides', 'Sides — moneyline + spread'],
    ['totals', 'Totals'],
  ];
  for (const [group, label] of groups) {
    const rows = newBuilt.rows.filter(r => r.group === group);
    // Candidates: declared, computed, weighted 0, staked on nothing. Kept out of
    // the live table and given their own multiplicity correction — pooling them
    // would both raise the bar for the live features and let a candidate read as
    // though it were already earning its keep.
    const liveRows = rows.filter(r => !r.candidate);
    const candRows = rows.filter(r => r.candidate);
    const picks = (rs) => new Set(rs.map(r => r.pickId)).size;

    md += `# ${label}\n\n`;
    md += renderEra(
      `Clean regime — on/after ${CONTRIB_SCHEMA_CHANGE} (all 27 features recorded)`,
      'This is the era to trust. Every feature is present in every game, so absence is recorded rather than inferred.',
      liveRows, picks(liveRows));

    if (candRows.length) {
      md += renderEra(
        'Candidate features — weighted 0, staked on nothing',
        'These move no pick. They are logged so a weight can be justified BEFORE it is given, rather than by giving it one and seeing what happens. A candidate clearing the bar is a pre-registration, not a promotion.'
          + (group === 'totals' ? ' Candidates are home-minus-away differences, so for totals this table is close to a placebo: a hit here is more likely an artefact than a finding.' : ''),
        candRows, picks(candRows));
      md += renderBundle(candRows);
    }

    if (group === 'sides') {
      md += renderPreregistrations(league, candRows);

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
    }
  }

  if (oldBuilt.rows.length) {
    md += renderEra(
      `Legacy regime — before ${CONTRIB_SCHEMA_CHANGE} (top 5 features only, sides)`,
      'Shown for completeness only. Every r here is biased by top-5 selection; do not compare it to the tables above and do not act on it.',
      oldBuilt.rows.filter(r => r.group === 'sides'), oldBuilt.joined);
  }

  md += `**How to read this.** A positive r means: the more this feature favoured the side we picked, the `;
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
module.exports = { main, fetchAll, buildRows, renderPreregistrations, CONTRIB_SCHEMA_CHANGE };
