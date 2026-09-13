'use strict';
// =============================================================
// scripts/novig-fill-report.js
//
// "Does a resting maker order actually fill, and at what adverse selection?"
//
// That is the one question left on the table after the kill criterion fired on
// 2026-09-04. The 2026-08-31 venue table said the same tickets that lose
// 0.42pp at a book are +0.72pp as a Novig maker — but only if the orders fill,
// and only if the ones that fill are not systematically the ones the market
// was happy to give away. No amount of data already in hand answers that. A
// few dozen live maker fills do.
//
// `config/novig-fill-test.json` pre-registered the decision rule on
// 2026-09-12. `novig_orders` has been collecting posted / filled / unfilled
// rows since, and `src/novig-settle.js` closes out the ones never marked. This
// script reads all of that back and scores it. The arithmetic lives in the
// pure `src/novig-eval.js`; everything here is I/O and formatting.
//
// ── WHY IT READS THE WAY IT DOES ────────────────────────────────────────────
//
// PAGED, AND REFUSES A PARTIAL READ. PostgREST caps a response at 1000 rows
// regardless of the limit asked for. On 2026-09-06 that silently computed the
// feature report on ~40% of the data and nobody could tell. Every read here
// pages with `.range()` and reports the row count it actually got.
//
// JOINED ON pick_id. `novig_orders` deliberately does not duplicate the game,
// market, price or CLV — the ledger owns those. An order whose pick_id has no
// ledger row is counted and excluded rather than dropped silently.
//
// UNITS. `clv_prob_delta` is stored as a fraction; `src/venue-cost.js` returns
// fractions. `src/novig-eval.js` works in probability POINTS. The ×100 happens
// here, once, and nowhere else — a factor-of-100 slip would read as a
// spectacular edge rather than as an error.
//
// Usage: node scripts/novig-fill-report.js [--since 2026-09-12] [--write]
// =============================================================

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { evaluateFillTest, MEASURED_FROM_ISO } = require('../src/novig-eval');
const { venueCost } = require('../src/venue-cost');
const { americanToImpliedProb, isValidAmericanOdds } = require('../src/market-pricing');

const OUT_DIR = path.join(__dirname, '..', 'novig-fill-reports');
const PAGE = 1000;

function fmt(v, d = 3, sign = false) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${sign && n >= 0 ? '+' : ''}${n.toFixed(d)}`;
}

function pct(v, d = 1) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return `${(Number(v) * 100).toFixed(d)}%`;
}

/**
 * Read every matching row, not the first 1000. `build()` must return a FRESH
 * query builder each call — a supabase-js builder is single-use.
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
 * Join an order to its ledger row and convert to the pure module's shape.
 *
 * `priceGainPp` is the improvement locked in by posting rather than taking:
 * the book's implied probability minus the posted contract price (Novig quotes
 * in probability cents — a 41c contract is +140). It is reported but never
 * primary; see refusal 4 in src/novig-eval.js.
 */
function normalize(orders, byPickId) {
  const rows = [];
  let unjoined = 0;
  for (const o of orders) {
    const led = byPickId.get(o.pick_id);
    if (!led) { unjoined++; continue; }

    const clvPp = led.clv_prob_delta == null ? null : Number(led.clv_prob_delta) * 100;

    // What Novig charges a maker, on this contract, per config/venues.json.
    // Computed rather than hardcoded to zero so a change to the fee schedule
    // shows up here instead of being quietly assumed away.
    const cents = Number(o.fill_cents != null ? o.fill_cents : o.posted_cents);
    const p = Number.isFinite(cents) ? cents / 100 : null;
    const vigPp = p === null ? null : venueCost('novig', p, 'maker') * 100;

    let priceGainPp;
    if (p !== null && isValidAmericanOdds(led.odds)) {
      priceGainPp = (americanToImpliedProb(led.odds) - p) * 100;
    }

    rows.push({
      pickId: o.pick_id,
      gameKey: led.game || null,
      market: led.market || null,
      league: led.league || null,
      orderedDate: o.game_date || (o.ordered_at ? String(o.ordered_at).slice(0, 10) : null),
      state: o.state,
      clvPp,
      vigPp,
      priceGainPp,
    });
  }
  return { rows, unjoined };
}

function renderKillChecks(checks) {
  let md = '| Pre-registered kill condition | Status | Detail |\n|---|---|---|\n';
  for (const c of checks) {
    const s = c.status === 'FIRED' ? '**FIRED**'
      : c.status === 'FLAGGED' ? '**flagged**'
      : c.status === 'passed' ? 'passed' : 'not yet checkable';
    md += `| ${c.text} | ${s} | ${c.detail} |\n`;
  }
  return md;
}

function render(result, meta) {
  const f = result.forward;
  const today = new Date().toISOString().slice(0, 10);

  let md = `# Novig Maker-Fill Test — ${today}\n\n`;
  md += `Pre-registered ${meta.preRegDate} in \`config/novig-fill-test.json\`. `;
  md += `Scored by \`src/novig-eval.js\`; this report decides nothing and stakes nothing.\n\n`;
  md += `**The question:** posting a maker order 10 cents better than the best book `;
  md += `is worth ~2.2pp of price against a book vig of ~1.7pp — the first mechanism in `;
  md += `this project of the right order of magnitude to clear the wall. Does it survive `;
  md += `adverse selection?\n\n`;

  md += `## Verdict\n\n> **${result.verdict}**\n\n`;
  md += `Bar: fill-conditional net edge > 0 at |t| ≥ ${result.tBar}, clustered by game, `;
  md += `minimum ${result.minFills} fills, measured from ${result.measuredFrom}.\n\n`;

  md += `## Fills\n\n`;
  md += `| | Count |\n|---|---|\n`;
  md += `| Posted (forward) | ${f.posted} |\n`;
  md += `| Filled | ${f.filled} |\n`;
  md += `| No fill | ${f.unfilled} |\n`;
  md += `| Still open (not yet an observation) | ${f.open} |\n`;
  md += `| **Fill rate** | **${pct(f.fillRate)}** of ${f.decided} decided |\n\n`;
  md += `An open order is excluded from the rate rather than counted as a miss — otherwise `;
  md += `the number would depend on what time the report ran.\n\n`;

  md += `## Net edge on filled orders\n\n`;
  md += `| Basis | Games | Mean | sd | t | Resolvable | Games needed |\n|---|---|---|---|---|---|---|\n`;
  md += `| **At the logged price (pre-registered, pessimistic)** | ${f.netEdge.games} | `
      + `${fmt(f.netEdge.meanPp, 3, true)}pp | ${fmt(f.netEdge.sdPp)} | ${fmt(f.netEdge.t, 2, true)} | `
      + `${f.netEdge.resolvable ? 'yes' : 'no'} | ${f.netEdge.gamesNeeded ?? '—'} |\n`;
  md += `| At the fill price (optimistic, credits the 10c) | ${f.netEdgeAtFillPrice.games} | `
      + `${fmt(f.netEdgeAtFillPrice.meanPp, 3, true)}pp | ${fmt(f.netEdgeAtFillPrice.sdPp)} | `
      + `${fmt(f.netEdgeAtFillPrice.t, 2, true)} | ${f.netEdgeAtFillPrice.resolvable ? 'yes' : 'no'} | `
      + `${f.netEdgeAtFillPrice.gamesNeeded ?? '—'} |\n\n`;
  md += `The verdict follows the **first** row. \`clv_prob_delta\` is already measured against `;
  md += `the ledger's price, so adding the improvement on top risks counting it twice. `;
  md += `Unmodelled upside is safe; unmodelled cost is not.\n\n`;

  md += `## Adverse selection — are the fills the market's rejects?\n\n`;
  md += `| | Games | Mean CLV |\n|---|---|---|\n`;
  md += `| Filled | ${f.filledClv.games} | ${fmt(f.filledClv.meanPp, 3, true)}pp |\n`;
  md += `| No fill | ${f.missedClv.games} | ${fmt(f.missedClv.meanPp, 3, true)}pp |\n`;
  md += `| **CLV capture ratio** | | **${fmt(f.captureRatio, 2)}** |\n\n`;
  if (f.selection) {
    md += `Filled minus missed: ${fmt(f.selection.diff, 3, true)}pp, Welch t `
        + `${fmt(f.selection.t, 2, true)} (clustered by game).\n\n`;
  } else {
    md += `_Not yet measurable — one side is too thin._\n\n`;
  }
  md += `A ratio near 1 means the venue is not picking us off. Well under 1 means the misses `;
  md += `were the windfalls. This figure exists only because the misses are recorded; a `;
  md += `fill-only log answers a flattering version of the question.\n\n`;

  md += `## Pre-registered kill conditions\n\n${renderKillChecks(result.killChecks)}\n`;

  const mix = f.marketMix;
  md += `## Market mix of fills\n\n`;
  if (mix.total) {
    md += `| Market | Fills | Share |\n|---|---|---|\n`;
    for (const [m, c] of Object.entries(mix.counts).sort((a, b) => b[1] - a[1])) {
      md += `| ${m} | ${c} | ${pct(mix.shares[m])} |\n`;
    }
    md += `\n`;
  } else {
    md += `_No fills yet._\n\n`;
  }

  md += `## The 2026-09-11 pilot — NOT evidence\n\n`;
  md += `${result.pilot.orders} order(s) before the pre-registration date: `;
  md += `${result.pilot.filled} filled, ${result.pilot.unfilled} no fill, `;
  md += `${result.pilot.open} open. Reported so the forward sample can be compared against `;
  md += `what prompted it. **Never pooled with the test above** — it is eight orders on one `;
  md += `day, and that day ran roughly double rule C's historical CLV.\n\n`;

  md += `## Read integrity\n\n`;
  md += `- \`novig_orders\` rows read: **${meta.orderRows}**\n`;
  md += `- ledger rows joined: **${meta.ledgerRows}**\n`;
  md += `- orders with no matching ledger row (excluded): **${meta.unjoined}**\n`;
  md += `- orders in an unusable state or with an unparseable date (excluded): **${result.unusable}**\n`;
  return md;
}

async function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : MEASURED_FROM_ISO;
  const write = args.includes('--write');

  const sb = db.getClient();
  if (!sb) {
    console.error('Supabase not configured — this report needs live credentials (run it in CI).');
    process.exit(1);
  }

  const orders = await fetchAll(
    () => sb.from('novig_orders')
      .select('pick_id, game_date, ordered_at, posted_cents, fill_cents, state')
      .order('pick_id', { ascending: true }),
    'novig_orders');

  if (!orders.length) {
    console.log('No Novig orders logged yet — nothing to score.');
    return;
  }

  // Chunked `.in()` so a long id list cannot blow the URL length limit.
  const ids = orders.map((o) => o.pick_id).filter(Boolean);
  const ledger = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const part = await fetchAll(
      () => sb.from('performance_log')
        .select('pick_id, game, market, league, odds, clv_prob_delta')
        .in('pick_id', chunk)
        .order('pick_id', { ascending: true }),
      'performance_log');
    ledger.push(...part);
  }
  const byPickId = new Map(ledger.map((r) => [r.pick_id, r]));

  const { rows, unjoined } = normalize(orders, byPickId);
  const result = evaluateFillTest(rows, { measuredFromISO: since });
  const md = render(result, {
    preRegDate: '2026-09-12',
    orderRows: orders.length,
    ledgerRows: ledger.length,
    unjoined,
  });

  console.log(md);
  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(out, md);
    console.error(`wrote ${out}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { normalize, render, fetchAll };
