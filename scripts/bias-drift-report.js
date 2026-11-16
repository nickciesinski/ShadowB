'use strict';
// =============================================================
// scripts/bias-drift-report.js — weekly pick-bias drift check (READ-ONLY).
//
// Watches the leans fixed on 2026-06-10 (totals Over bias from a low market
// anchor; home tilt from sp_prob) and the NBA favorite lean spotted
// 2026-11-16 (spreads 93% favorites -> stretched margins).
//
// For the 7 days ending yesterday, per league x market, for all picks and
// for staked (approved) picks:
//   totals    Over%
//   moneyline Home%, Favorite% (odds < 0; note only)
//   spread    Home%, Favorite% (line < 0)
// plus the live weights (config/model-params.*.json): total market anchor and
// sp_prob. Writes bias-drift-reports/<date>.md. Never writes weights/picks.
//
// Usage: node scripts/bias-drift-report.js [--dry-run]
// =============================================================

const fs = require('fs');
const path = require('path');

const LEAGUES = ['NFL', 'NBA', 'NHL', 'MLB'];
const MARKETS = ['moneyline', 'spread', 'total'];
const MIN_SAMPLE = 15;
const BANDS = {
  over: [38, 62],      // totals Over%
  home: [32, 68],      // ML / spread Home%
  spreadFav: [25, 75], // spread Favorite%
};
const WATCH_MARGIN = 3;

function normMarket(s) {
  const m = String(s || '').toLowerCase();
  if (m.includes('money') || m === 'h2h') return 'moneyline';
  if (m.includes('spread') || m.includes('run line') || m.includes('puck')) return 'spread';
  if (m.includes('total') || m === 'over' || m === 'under') return 'total';
  return m;
}

/** "Away @ Home" -> {away, home}. */
function splitGame(game) {
  const parts = String(game || '').split(' @ ');
  return parts.length === 2 ? { away: parts[0].trim(), home: parts[1].trim() } : { away: '', home: '' };
}

function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : null; }

/** OK / WATCH / DRIFT for a percentage against a [lo, hi] band. */
function verdict(p, band) {
  if (p === null) return '—';
  const [lo, hi] = band;
  if (p > hi || p < lo) return 'DRIFT';
  if (p > hi - WATCH_MARGIN || p < lo + WATCH_MARGIN) return 'WATCH';
  return 'OK';
}

const RANK = { '—': 0, OK: 1, WATCH: 2, DRIFT: 3 };
function worst(...vs) { return vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), '—'); }

/** Lean stats for one set of rows of a single market. */
function cellStats(rows, market) {
  const out = { n: rows.length };
  if (market === 'total') {
    let o = 0, u = 0;
    for (const r of rows) {
      const p = String(r.pick || '').trim().toLowerCase();
      if (p.startsWith('over')) o++; else if (p.startsWith('under')) u++;
    }
    out.overPct = pct(o, o + u); out.over = o; out.ou = o + u;
    out.verdict = verdict(out.overPct, BANDS.over);
    return out;
  }
  let h = 0, a = 0, fav = 0, priced = 0;
  for (const r of rows) {
    const { away, home } = splitGame(r.game);
    const pick = String(r.pick || '').trim();
    if (pick && pick === home) h++; else if (pick && pick === away) a++;
    const x = Number(market === 'spread' ? r.line : r.odds);
    if (r[market === 'spread' ? 'line' : 'odds'] != null && Number.isFinite(x) && x !== 0) {
      priced++; if (x < 0) fav++;
    }
  }
  out.homePct = pct(h, h + a); out.home = h; out.ha = h + a;
  out.favPct = pct(fav, priced); out.fav = fav; out.priced = priced;
  const vHome = verdict(out.homePct, BANDS.home);
  // Moneyline favorite% is note-only: favorites are usually the likelier winner.
  const vFav = market === 'spread' ? verdict(out.favPct, BANDS.spreadFav) : '—';
  out.verdict = worst(vHome, vFav);
  return out;
}

/** Spread favorite cover rate among graded picks (W/L only). */
function favCoverRate(rows) {
  let w = 0, l = 0;
  for (const r of rows) {
    const x = Number(r.line);
    if (!(Number.isFinite(x) && x < 0)) continue;
    const res = String(r.result || '').trim().toUpperCase();
    if (res === 'W') w++; else if (res === 'L') l++;
  }
  return { w, l, pct: pct(w, w + l) };
}

/** Build the per-league x market table from Supabase-shaped rows. */
function analyze(rows) {
  const cells = [];
  for (const lg of LEAGUES) {
    for (const mk of MARKETS) {
      const all = rows.filter(r => String(r.league || '').toUpperCase() === lg && normMarket(r.market) === mk);
      if (!all.length) continue;
      const staked = all.filter(r => String(r.approval_status || '').trim().toLowerCase() === 'approved');
      cells.push({ league: lg, market: mk, all: cellStats(all, mk), staked: cellStats(staked, mk) });
    }
  }
  return cells;
}

/** Weights sanity from the live param store. */
function weightsCheck(paramsByLeague) {
  const lines = [];
  let drift = false;
  for (const lg of LEAGUES) {
    const p = paramsByLeague[lg];
    if (!p) { lines.push({ league: lg, note: 'no params file' }); continue; }
    const anchor = p.params ? p.params.param_auto_total_market_anchor : undefined;
    const ml = p.moneyline || {};
    const sp = [ml.sp_prob_home, ml.sp_prob_away].filter(v => v != null).map(Number);
    const spMax = sp.length ? Math.max(...sp) : null;
    const bad = [];
    if (anchor != null && Number(anchor) < 0.90) bad.push(`anchor ${anchor} < 0.90 (Over-bias risk)`);
    if (spMax != null && spMax > 0.5) bad.push(`sp_prob ${spMax} > 0.5 (home-tilt risk)`);
    if (bad.length) drift = true;
    lines.push({ league: lg, anchor, spMax, verdict: bad.length ? 'DRIFT' : 'OK', note: bad.join('; ') });
  }
  return { lines, drift };
}

const P = (x) => (x === null || x === undefined ? '—' : `${x}%`);
function fmtCell(c, market) {
  const s = (x) => (x.n < MIN_SAMPLE ? ' (insufficient sample)' : '');
  if (market === 'total') {
    return {
      lean: `Over ${P(c.all.overPct)} / ${P(c.staked.overPct)}`,
      fav: '—',
      note: s(c.all),
    };
  }
  return {
    lean: `Home ${P(c.all.homePct)} / ${P(c.staked.homePct)}`,
    fav: `${P(c.all.favPct)} / ${P(c.staked.favPct)}${market === 'moneyline' ? ' (note)' : ''}`,
    note: s(c.all),
  };
}

function buildMarkdown({ dateStr, from, to, latestPickDate, rows, cells, weights, cover }) {
  let md = `# Bias-Drift Check — ${dateStr}\n\n`;
  md += `Window: **${from} → ${to}** (7 days ending yesterday), pick_regime v2_clv. `;
  md += `Most recent pick date: **${latestPickDate || 'none'}**. Picks in window: ${rows.length}.\n\n`;
  if (!rows.length) {
    md += `**⚠ NO PICKS IN WINDOW — pipeline may be down.**\n`;
  } else {
    md += `Bands: totals Over% 38–62 · ML/spread Home% 32–68 · spread Fav% 25–75 (ML Fav% is note-only). WATCH = within 3 pts of a band. Cells with < ${MIN_SAMPLE} picks are insufficient sample.\n\n`;
    md += `| League | Market | Sample (all/staked) | Over% / Home% (all/staked) | Fav% (all/staked) | Verdict |\n|---|---|---|---|---|---|\n`;
    for (const c of cells) {
      const f = fmtCell(c, c.market);
      const v = worst(c.all.verdict, c.staked.n >= MIN_SAMPLE ? c.staked.verdict : '—');
      md += `| ${c.league} | ${c.market} | ${c.all.n}/${c.staked.n} | ${f.lean} | ${f.fav} | ${v}${f.note} |\n`;
    }
    if (cover && cover.w + cover.l > 0) {
      md += `\nNBA spread favorite cover rate (graded): ${cover.w}-${cover.l} / ${cover.pct}%\n`;
    } else {
      md += `\nNBA spread favorite cover rate: no graded NBA spread favorites in window.\n`;
    }
  }
  md += `\n## Live weights (config/model-params.*.json)\n\nExpected: total market anchor ≈ 0.95, sp_prob ≤ 0.1.\n\n`;
  md += `| League | Anchor | Max sp_prob | Verdict |\n|---|---|---|---|\n`;
  for (const w of weights.lines) {
    md += `| ${w.league} | ${w.anchor ?? '—'} | ${w.spMax ?? '—'} | ${w.verdict || '—'}${w.note ? ' — ' + w.note : ''} |\n`;
  }
  const drifting = cells.filter(c => c.all.verdict === 'DRIFT' || (c.staked.n >= MIN_SAMPLE && c.staked.verdict === 'DRIFT'));
  md += `\n## Overall\n\n`;
  if (!rows.length) md += `**NO DATA** — check the pipeline.\n`;
  else if (!drifting.length && !weights.drift) md += `All cells within bands; weights intact.\n`;
  else {
    md += `**DRIFT**: ${drifting.map(c => `${c.league} ${c.market}${c.all.n < MIN_SAMPLE ? ' (small n)' : ''}`).join(', ') || 'weights'}${weights.drift ? '; weights regressed' : ''}.\n\n`;
    md += `Likely causes: heavy Over → totals anchor pushed below 0.90; heavy Home → sp_prob fix undone; heavy spread favorites (esp. NBA) → projected margins too large vs the market line (projectMargin in src/game-model.js has no pull toward the line; early-season stats).\n`;
  }
  return md;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  const db = require('../src/db');
  const dryRun = process.argv.includes('--dry-run');
  // Pacific "today" so the window lines up with Nick's betting days.
  const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const to = new Date(nowPT); to.setDate(nowPT.getDate() - 1);
  const from = new Date(nowPT); from.setDate(nowPT.getDate() - 7);
  const dateStr = isoDate(nowPT), fromStr = isoDate(from), toStr = isoDate(to);

  if (!db.isEnabled()) { console.error('[drift] Supabase not configured'); process.exit(1); }
  const recent = await db.getRecentPerformanceLog(isoDate(new Date(nowPT.getTime() - 60 * 864e5)), { pickRegime: 'v2_clv' });
  if (recent == null) { console.error('[drift] Supabase read failed'); process.exit(1); }
  const latestPickDate = recent.reduce((m, r) => (String(r.date) > m ? String(r.date) : m), '').slice(0, 10) || null;
  const rows = recent.filter(r => { const d = String(r.date).slice(0, 10); return d >= fromStr && d <= toStr; });

  const cells = analyze(rows);
  const nbaSpread = rows.filter(r => String(r.league).toUpperCase() === 'NBA' && normMarket(r.market) === 'spread');
  const cover = favCoverRate(nbaSpread);

  const paramsByLeague = {};
  for (const lg of LEAGUES) {
    try { paramsByLeague[lg] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', `model-params.${lg}.json`), 'utf8')); } catch (e) { /* missing */ }
  }
  const weights = weightsCheck(paramsByLeague);
  const md = buildMarkdown({ dateStr, from: fromStr, to: toStr, latestPickDate, rows, cells, weights, cover });

  if (dryRun) { console.log(md); return; }
  const dir = path.join(__dirname, '..', 'bias-drift-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${dateStr}.md`), md);
  console.log(`[drift] wrote bias-drift-reports/${dateStr}.md (${rows.length} picks)`);
}

if (require.main === module) {
  main().catch(e => { console.error('[drift] FATAL:', e.message); process.exit(1); });
}

module.exports = { analyze, cellStats, verdict, weightsCheck, favCoverRate, buildMarkdown, splitGame, normMarket, BANDS, MIN_SAMPLE };
