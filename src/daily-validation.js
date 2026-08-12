// ── daily-validation ─────────────────────────────────────────────────────────
//
// A layered integrity check that runs every day and writes its results to
// debug_probe, where they can be read directly.
//
// WHY THIS EXISTS. Before 2026-08-08 this system had six simultaneous silent
// failures: prices separated from their lines, 57% of MLB weight mass pointed
// at feature names nothing produced, four "features" that were one number
// scaled, run differential reading season totals, and a report blending two
// regimes into a 19.5% ROI headline while the real figure was -0.5%. Every
// workflow was green throughout. The checklist that would have caught these
// existed only as SQL in a doc, which means it ran when somebody remembered.
//
// THE PRINCIPLE. Each layer must be trusted before the next one means
// anything:
//
//   Data -> Features -> Model -> Price -> Measurement
//
// A CLV number computed on top of a corrupt feature is not a weak signal, it
// is a meaningless one. So the layers are reported in order and each carries
// its own pass/fail, rather than collapsing into a single score that hides
// which layer broke.
//
// Results go to debug_probe rather than stdout because GitHub Actions log
// downloads are outside the dev egress allowlist — a diagnostic printed to
// stdout is unreadable, which is how the runsPerGame bug survived an extra
// day. See src/debug-probe.js.

const db = require('./db');
const { probe } = require('./debug-probe');
const { checkDeadWeights } = require('./feature-health');

const LEAGUES = ['MLB', 'NBA', 'NFL', 'NHL'];

// The baseline model. Rows from earlier versions are different models and must
// never be pooled — v2.2-corrupt-offense in particular was produced while one
// feature contributed 89% of total score.
const BASELINE_VERSION_PREFIX = 'v2.3';

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const round = (v, d = 5) => (v == null ? null : Number(v.toFixed(d)));

// ── Layer 1: DATA ────────────────────────────────────────────────────────────
// Did today produce a plausible number of tickets, and is the ledger clean of
// the duplication that the exactly-once rule exists to prevent?
async function checkData(sb, todayISO) {
  const { data, error } = await sb.from('performance_log')
    .select('pick_id, league, market, game_key, game_date, locked_at')
    .eq('pick_regime', 'v2_clv').gte('game_date', todayISO);
  if (error) return { pass: false, error: error.message };

  const rows = data || [];
  const byLeague = {};
  const seen = new Set();
  let dupes = 0;
  for (const r of rows) {
    byLeague[r.league] = (byLeague[r.league] || 0) + 1;
    const k = `${r.game_key}|${r.market}`;
    if (seen.has(k)) dupes++;
    seen.add(k);
  }
  // Every game should yield exactly three markets. A ratio far from 3 means
  // either the generator is dropping markets or the flood bug has returned.
  const games = new Set(rows.map((r) => r.game_key)).size;
  const ratio = games ? Number((rows.length / games).toFixed(2)) : null;

  // No tickets yet is normal before the daily lock runs; it is not a failure.
  // Only a non-empty slate with a wrong markets-per-game ratio is.
  const notYetRun = rows.length === 0;
  return {
    pass: dupes === 0 && (notYetRun || (ratio > 2.5 && ratio < 3.5)),
    not_yet_run: notYetRun,
    tickets: rows.length, games, markets_per_game: ratio,
    duplicate_game_market: dupes, by_league: byLeague,
  };
}

// ── Layer 2: FEATURES ────────────────────────────────────────────────────────
// Does every weighted feature exist, and does it vary? A feature that is
// present, weighted, non-zero and yet constant carries no information.
async function checkFeatures(sb, todayISO) {
  const out = { pass: true, leagues: {}, coverage: {} };

  for (const lg of LEAGUES) {
    try {
      const dw = checkDeadWeights(lg);
      const unexpected = [];
      for (const m of dw.markets || []) {
        out.coverage[`${lg}.${m.market}`] = m.liveMassPct;
        if (m.unexpected && m.unexpected.length) unexpected.push(...m.unexpected);
      }
      if (unexpected.length) { out.pass = false; out.leagues[lg] = { new_dead_weights: unexpected }; }
    } catch (err) {
      out.pass = false; out.leagues[lg] = { error: err.message };
    }
  }

  // Variance across today's actual slate.
  const { data } = await sb.from('prediction_features')
    .select('league, features').gte('date', todayISO).limit(500);
  const byLeague = {};
  for (const r of data || []) (byLeague[r.league] = byLeague[r.league] || []).push(r.features || {});

  out.collapsed = {};
  for (const [lg, rowsF] of Object.entries(byLeague)) {
    if (rowsF.length < 6) continue;
    const vals = {};
    for (const f of rowsF) {
      for (const [k, v] of Object.entries(f)) {
        const n = num(v);
        if (n === null) continue;
        (vals[k] = vals[k] || new Set()).add(Number(n.toFixed(6)));
      }
    }
    // All-zero features belong to other leagues and are expected.
    const collapsed = Object.entries(vals)
      .filter(([, s]) => s.size === 1 && !s.has(0))
      .map(([k]) => k);
    if (collapsed.length) out.collapsed[lg] = collapsed.slice(0, 10);
  }
  return out;
}

// ── Layer 3: MODEL ───────────────────────────────────────────────────────────
// Is the model differentiating games, and is any single feature eating it?
//
// Both failure modes are real history: model_prob took FOUR distinct values
// across fifteen games every day (a confidence-tier lookup, not a
// probability), and offense_rs_diff once contributed 89% of total score.
async function checkModel(sb, todayISO) {
  const { data, error } = await sb.from('performance_log')
    .select('market, model_prob, model_version')
    .eq('pick_regime', 'v2_clv').gte('game_date', todayISO);
  if (error) return { pass: false, error: error.message };

  const byMarket = {};
  for (const r of data || []) {
    const p = num(r.model_prob);
    if (p === null) continue;
    (byMarket[r.market] = byMarket[r.market] || []).push(p);
  }
  const markets = {};
  let pass = true;
  for (const [m, ps] of Object.entries(byMarket)) {
    const distinct = new Set(ps.map((p) => p.toFixed(4))).size;
    const ratio = ps.length ? distinct / ps.length : 1;
    // Below ~0.5 means the model is bucketing rather than differentiating.
    if (ps.length >= 8 && ratio < 0.5) pass = false;
    markets[m] = {
      n: ps.length, distinct, distinct_ratio: Number(ratio.toFixed(2)),
      min: round(Math.min(...ps), 3), max: round(Math.max(...ps), 3),
    };
  }

  // Dominance, as recorded by game-model during generation.
  const { data: dom } = await sb.from('debug_probe')
    .select('created_at, payload').eq('label', 'feature-dominance')
    .gte('created_at', `${todayISO}T00:00:00Z`).limit(5);
  const dominance = (dom || []).map((d) => d.payload?.offenders?.[0]).filter(Boolean);
  if (dominance.length) pass = false;

  const versions = {};
  for (const r of data || []) versions[r.model_version || '(null)'] = (versions[r.model_version || '(null)'] || 0) + 1;

  return { pass, markets, dominance, model_versions: versions };
}

// ── Layer 4: PRICE ───────────────────────────────────────────────────────────
// Is the recorded price real, reachable, and attached to the right line?
async function checkPrice(sb, sinceISO) {
  const { data, error } = await sb.from('performance_log')
    .select('market, line, close_line, odds, close_odds, placed_book, close_lag_hours, clv_prob_delta, clv_basis, status, graded_at, model_version, commence_time')
    .eq('pick_regime', 'v2_clv').gte('game_date', sinceISO);
  if (error) return { pass: false, error: error.message };

  const all = data || [];
  // INTEGRITY checks run only on baseline-version rows. The spread side-flip,
  // impossible-CLV and placed_book defects were all fixed on 2026-08-08/09, so
  // a rolling 7-day window keeps re-flagging rows that are already known-bad
  // and cannot be fixed. A check that fires on settled history is a check that
  // gets ignored, which defeats the purpose. Operational health (lag, grading
  // backlog) still spans the full window, since those apply to every row
  // regardless of which model produced it.
  const rows = all.filter((r) => String(r.model_version || '').startsWith(BASELINE_VERSION_PREFIX));
  let sideFlip = 0, negLag = 0, impossible = 0, nullBook = 0;
  const books = {};
  for (const r of rows) {
    const l = num(r.line), cl = num(r.close_line);
    if (r.market === 'spread' && l !== null && cl !== null && Math.sign(l) !== Math.sign(cl)) sideFlip++;
    if (num(r.close_lag_hours) !== null && num(r.close_lag_hours) < 0) negLag++;
    const clv = num(r.clv_prob_delta);
    if (clv !== null && Math.abs(clv) > 0.10) impossible++;
    if (!r.placed_book) nullBook++;
    if (r.placed_book) books[r.placed_book] = (books[r.placed_book] || 0) + 1;
  }

  // Operational health across every row in the window.
  //
  // 2026-08-11: the first run reported 18 "ungraded past close", which was a
  // false alarm in this check rather than a grader problem — those games had
  // started 2.6 hours earlier and MLB games run about three. Counting any
  // closed-but-ungraded ticket flags every in-progress game every evening,
  // which trains you to ignore the number. Only tickets whose game started
  // long enough ago that it must have finished count as a backlog.
  const GRADE_GRACE_HOURS = 6;
  let ungraded = 0;
  const lags = [];
  const nowMs = Date.now();
  for (const r of all) {
    const lag = num(r.close_lag_hours);
    if (lag !== null) lags.push(lag);
    if (r.status === 'closed' && !r.graded_at && r.commence_time) {
      const hrs = (nowMs - new Date(r.commence_time).getTime()) / 3.6e6;
      if (Number.isFinite(hrs) && hrs > GRADE_GRACE_HOURS) ungraded++;
    }
  }

  // Books we cannot actually bet at. A price sourced from an unreachable book
  // is fiction — that error made moneyline look +0.133pp when the reachable
  // figure was about -0.38pp.
  const REACHABLE = new Set(['bovada', 'betonlineag', 'consensus_median']);
  const unreachable = Object.entries(books)
    .filter(([b]) => !REACHABLE.has(b))
    .reduce((acc, [b, n]) => { acc[b] = n; return acc; }, {});

  return {
    pass: sideFlip === 0 && negLag === 0 && impossible === 0
      && Object.keys(unreachable).length === 0,
    baseline_n: rows.length, window_n: all.length,
    spread_side_flip: sideFlip, negative_lag: negLag,
    impossible_clv: impossible, null_placed_book: nullBook,
    unreachable_books: unreachable,
    ungraded_past_close: ungraded,
    median_close_lag_h: lags.length ? round(lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)], 2) : null,
    placed_book_mix: books,
    note: `integrity scoped to ${BASELINE_VERSION_PREFIX}* rows; lag/grading span the full window`,
  };
}

// ── Layer 5: MEASUREMENT ─────────────────────────────────────────────────────
// The actual scoreboard. Net edge = CLV - vig, which IS expected ROI per unit
// staked. Reported by segment so the shape of the model is visible as the
// sample grows — OBSERVED, not acted upon. Nine slices on 150 rows will throw
// a t of 3 by chance; segment-level decisions belong to the staking gate,
// after the baseline question is settled.
async function checkMeasurement(sb) {
  const { data, error } = await sb.from('performance_log')
    .select('league, market, lock_window, days_to_game, odds, model_prob, result, unit_return, clv_prob_delta, vig_paid_pp, net_edge_pp, model_version, placed_book, tradeable')
    .eq('pick_regime', 'v2_clv').eq('clv_basis', 'novig').lte('close_lag_hours', 6)
    .like('model_version', `${BASELINE_VERSION_PREFIX}%`).limit(5000);
  if (error) return { pass: false, error: error.message };

  // Exclude prices from books we cannot bet at. buildGameObjects falls back to
  // the full book set when neither Bovada nor BetOnline quotes a market, so a
  // few tickets carry a price that was never actually available. Leaving them
  // in is the same error that made moneyline look +0.133pp when the reachable
  // figure was about -0.38pp — just smaller and harder to notice.
  // `tradeable` is stamped at write time (predictions.js) rather than
  // re-derived here, so the book list can change without silently rewriting
  // history. Older rows were backfilled from placed_book.
  const all = (data || []).filter((r) => num(r.net_edge_pp) !== null);
  const rows = all.filter((r) => r.tradeable !== false);
  const excludedUnreachable = all.length - rows.length;
  const summarise = (rs) => {
    const ne = rs.map((r) => num(r.net_edge_pp)).filter((v) => v !== null);
    const clv = rs.map((r) => num(r.clv_prob_delta)).filter((v) => v !== null);
    const s = sd(ne), m = mean(ne);
    return {
      n: rs.length,
      mean_clv: round(mean(clv)),
      mean_vig: round(mean(rs.map((r) => num(r.vig_paid_pp)).filter((v) => v !== null))),
      net_edge: round(m),
      t_stat: (s && s > 0 && ne.length > 1) ? round((m / s) * Math.sqrt(ne.length), 2) : null,
      units: round(rs.reduce((a, r) => a + (num(r.unit_return) || 0), 0), 2),
    };
  };
  const group = (keyFn) => {
    const g = {};
    for (const r of rows) { const k = keyFn(r); if (k == null) continue; (g[k] = g[k] || []).push(r); }
    const out = {};
    for (const [k, v] of Object.entries(g)) if (v.length >= 8) out[k] = summarise(v);
    return out;
  };

  return {
    pass: true, // measurement never fails the run; it is the readout
    excluded_unreachable_book: excludedUnreachable,
    overall: summarise(rows),
    by_market: group((r) => r.market),
    by_league_market: group((r) => `${r.league}.${r.market}`),
    by_lock_window: group((r) => r.lock_window),
    by_days_to_game: group((r) => `d${r.days_to_game}`),
    // Derivable post-hoc from stored columns; no extra stamping needed.
    by_price_bucket: group((r) => {
      const o = num(r.odds); if (o === null) return null;
      return o <= -150 ? 'a_big_fav' : o < 0 ? 'b_small_fav' : o < 150 ? 'c_small_dog' : 'd_big_dog';
    }),
    by_confidence: group((r) => {
      const p = num(r.model_prob); if (p === null) return null;
      return p < 0.45 ? 'a_lt45' : p < 0.55 ? 'b_45_55' : p < 0.65 ? 'c_55_65' : 'd_gte65';
    }),
  };
}

// ── Kill criterion ───────────────────────────────────────────────────────────
// Quantified so it can actually fire. sd(net_edge) ~ 0.041 in this data, so
// SE at n=800 is ~0.0015 and a +0.005 edge is detectable at better than 3
// sigma. MARKET level deliberately, not league x market x window: finer
// segments would each need ~800 rows, which is over a year of data, and a
// criterion you cannot reach is not a criterion.
function killCriterion(measurement, opts = {}) {
  const target = opts.target ?? 0.005;
  const minN = opts.minN ?? 800;
  const o = measurement.overall || {};
  if (!o.n || o.n < minN) {
    return { status: 'accumulating', n: o.n || 0, needed: minN,
      note: `${minN - (o.n || 0)} more clean tickets before this question can be answered.` };
  }
  const survivors = Object.entries(measurement.by_market || {})
    .filter(([, s]) => s.net_edge != null && s.net_edge >= target && s.t_stat != null && s.t_stat > 2)
    .map(([k, s]) => ({ segment: k, net_edge: s.net_edge, t: s.t_stat, n: s.n }));
  const pooledPositive = o.net_edge != null && o.t_stat != null && o.net_edge > 0 && o.t_stat > 2;

  if (survivors.length || pooledPositive) {
    return { status: 'signal', survivors, pooled: o,
      note: 'A segment clears the bar. Proceed to calibration, then selection/timing.' };
  }
  return { status: 'STOP', survivors: [], pooled: o,
    note: `n=${o.n} with no market clearing +${target} at t>2 and no credible pooled edge. `
      + 'Stop adding model complexity. Redirect to selection and timing, or conclude no useful edge.' };
}

async function runDailyValidation() {
  const sb = db.getClient();
  if (!sb) return { ok: false, reason: 'no_db' };

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

  const data = await checkData(sb, today);
  const features = await checkFeatures(sb, today);
  const model = await checkModel(sb, today);
  const price = await checkPrice(sb, weekAgo);
  const measurement = await checkMeasurement(sb);
  const kill = killCriterion(measurement);

  // Layers are ordered, and the first failure is what matters: a CLV figure
  // computed on top of a corrupt feature is meaningless rather than merely
  // noisy. Report the earliest broken layer so attention goes to the cause.
  const layers = [
    ['data', data], ['features', features], ['model', model], ['price', price],
  ];
  const firstFailure = layers.find(([, v]) => v && v.pass === false);

  const report = {
    date: today,
    trust_broken_at: firstFailure ? firstFailure[0] : null,
    layers: { data, features, model, price, measurement },
    kill_criterion: kill,
  };
  await probe('daily-validation', 'layered-report', report);

  console.log(`[daily-validation] ${today} trust_broken_at=${report.trust_broken_at || 'none'} `
    + `n=${measurement.overall?.n ?? 0} net_edge=${measurement.overall?.net_edge ?? 'n/a'} `
    + `kill=${kill.status}`);
  return { ok: true, report };
}

module.exports = {
  runDailyValidation, killCriterion,
  checkData, checkFeatures, checkModel, checkPrice, checkMeasurement,
};
