// ── Feature health ───────────────────────────────────────────────────────────
//
// Every bug found on 2026-08-08 was SILENT. The workflows were green, picks
// were produced, CLV was logged — and the MLB moneyline model was running on
// 43% of its weight mass with one three-valued input. Nothing failed, so
// nothing alerted. This module exists so that class of failure fails loudly.
//
// Two checks, aimed at the two things that actually went wrong:
//
//   1. DEAD WEIGHTS — a weight references a feature name extractFeatures never
//      emits. scoreMarket() does `features[key]`, gets undefined, and skips it
//      without a word. This is how run_differential_diff (weight 1.7) and
//      NHL's goal_differential_diff (3.0 on spread) contributed nothing for
//      months. A single typo silently deletes a feature.
//
//   2. COLLAPSED FEATURES — a feature exists and is weighted, but takes almost
//      no distinct values across a slate, so it carries no information. This is
//      how recent_form_*_diff sat at three distinct values (-0.5, 0, +0.5)
//      while being ~90% of the moneyline signal. A feature can be present,
//      weighted, non-zero, and still be dead.
//
// Neither check needs game results, so both run the moment picks are generated
// rather than waiting weeks for grading to reveal a problem.

const { extractFeatures } = require('./game-features');
const paramStore = require('./param-store');

// sp_* are injected downstream by game-model from market odds, not by
// extractFeatures, so they are legitimately absent at extraction time.
const MODEL_INJECTED = new Set([
  'sp_pred_margin', 'sp_pred_total', 'sp_prob_home', 'sp_prob_away',
  'sp_edge_ml_home', 'sp_edge_ml_away', 'sp_edge_spread_home',
  'sp_edge_spread_away', 'sp_edge_total',
]);

// Known-absent weights that are a deliberate decision rather than a bug.
// Keeping them listed means the report stays quiet about them but a NEW dead
// weight still shows up. Revisit when the underlying data gets collected.
const ACCEPTED_DEAD = new Set([
  // MLB: pitcher quality already enters via computePitcherAdj -> starterAdj.
  // Weighting these too would double count the ERA gap.
  'pitcher_matchup_score', 'era_diff', 'pitcher_quality_diff', 'pitcher_era_diff',
  'pitcher_home_advantage', 'pitcher_away_advantage',
  'home_pitcher_rating', 'away_pitcher_rating', 'ace_matchup', 'poor_pitching_matchup',
  // MLB/NFL: genuinely uncollected stats, not naming problems.
  'whip_diff', 'pitcher_whip_diff', 'bullpen_era_diff', 'ops_diff', 'batting_avg_diff',
  'weather_factor', 'home_field_advantage', 'division_game_factor',
  'turnover_impact', 'efficiency_diff', 'yards_diff', 'opp_yards_diff',
  'red_zone_diff', 'third_down_diff', 'pass_yards_diff', 'rush_yards_diff',
  'red_zone_combined', 'yards_combined', 'third_down_combined', 'turnover_combined',
  // NHL: uncollected special-teams and goaltending detail.
  'power_play_diff', 'penalty_kill_diff', 'save_percentage_diff', 'shots_diff',
  'faceoff_diff', 'goaltending_factor', 'combined_gf', 'shots_combined',
  'save_percentage_combined',
]);

// Features that are LEGITIMATELY low-cardinality and must not be flagged as
// collapsed. recent_form_l1_diff is the difference of two binary outcomes, so
// {-1, 0, 1} is correct and complete; b2b and the home-advantage constants are
// flags by construction. Without this list the variance check cries wolf every
// week and gets ignored, which is how a real alert gets missed.
const KNOWN_LOW_CARDINALITY = new Set([
  'recent_form_l1_diff', 'home_b2b', 'away_b2b', 'home_court_advantage',
  'home_ice_advantage', 'home_away_split_diff', 'home_field_advantage',
  'severe_injury_factor', 'injury_advantage',
]);

const MARKETS = ['moneyline', 'spread', 'total'];

/**
 * Which weighted features does this league's extractor fail to produce?
 * Uses a synthetic-but-complete team so the check is about VOCABULARY, not
 * about whether today's stats happened to load.
 */
function checkDeadWeights(league) {
  const probe = {
    wins: 50, losses: 40, pct: 0.556, offRating: 110, defRating: 108, pace: 99,
    runsPerGame: 4.6, runsAllowedPerGame: 4.3, goalsFor: 3.1, goalsAgainst: 2.9,
    pointsFor: 24, pointsAgainst: 21,
    recentFormPct: 0.6, formL1: '1', formL3: '0.667', formL5: '0.6',
  };

  let produced;
  try {
    produced = new Set(Object.keys(extractFeatures(probe, probe, {}, league)));
  } catch (err) {
    return { league, error: `extractFeatures threw: ${err.message}`, markets: [] };
  }

  const rows = [];
  for (const market of MARKETS) {
    let weights;
    try {
      weights = paramStore.load(league)?.[market];
    } catch (err) {
      weights = null;
    }
    if (!weights) continue;

    const active = Object.entries(weights)
      .filter(([, v]) => typeof v === 'number' && v !== 0);
    const dead = active.filter(([k]) =>
      !produced.has(k) && !MODEL_INJECTED.has(k));
    const unexpected = dead.filter(([k]) => !ACCEPTED_DEAD.has(k));

    const totalMass = active.reduce((s, [, v]) => s + Math.abs(v), 0);
    const deadMass = dead.reduce((s, [, v]) => s + Math.abs(v), 0);

    rows.push({
      market,
      weighted: active.length,
      dead: dead.length,
      liveMassPct: totalMass ? Math.round(100 * (1 - deadMass / totalMass)) : 0,
      unexpected: unexpected
        .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
        .map(([k, v]) => `${k}=${v}`),
    });
  }
  return { league, markets: rows };
}

/**
 * Which features barely vary across today's slate? A feature with one distinct
 * value contributes a constant — it shifts every pick identically and cannot
 * discriminate between games, which is indistinguishable from having no
 * feature at all.
 *
 * @param {Array<Object>} featureRows  one extractFeatures() output per game
 */
function checkFeatureVariance(featureRows, opts = {}) {
  const minGames = opts.minGames || 6;
  const suspectBelow = opts.suspectBelow || 4; // distinct values
  if (!Array.isArray(featureRows) || featureRows.length < minGames) {
    return { skipped: true, reason: `need >= ${minGames} games, got ${featureRows?.length || 0}` };
  }

  const values = {};
  for (const f of featureRows) {
    for (const [k, v] of Object.entries(f || {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      (values[k] = values[k] || new Set()).add(Number(v.toFixed(6)));
    }
  }

  const collapsed = [];
  for (const [k, set] of Object.entries(values)) {
    // All-zero features are usually another league's block and are expected.
    if (set.size === 1 && set.has(0)) continue;
    if (KNOWN_LOW_CARDINALITY.has(k)) continue;
    if (set.size < suspectBelow) {
      collapsed.push({ feature: k, distinct: set.size, games: featureRows.length });
    }
  }
  collapsed.sort((a, b) => a.distinct - b.distinct);
  return { skipped: false, games: featureRows.length, collapsed };
}

/**
 * Human-readable report for the weekly digest. Returns { text, alert } where
 * alert is true only for things that need a human — an unexpected dead weight
 * or a collapsed feature that is actually weighted.
 */
function report(leagues, featureRowsByLeague = {}) {
  const lines = [];
  let alert = false;

  for (const league of leagues) {
    const dw = checkDeadWeights(league);
    if (dw.error) {
      lines.push(`${league}: ERROR ${dw.error}`);
      alert = true;
      continue;
    }
    for (const m of dw.markets) {
      const flag = m.unexpected.length ? '  <-- NEW DEAD WEIGHT' : '';
      if (m.unexpected.length) alert = true;
      lines.push(`${league} ${m.market}: ${m.liveMassPct}% of weight mass live, `
        + `${m.dead}/${m.weighted} features missing${flag}`);
      if (m.unexpected.length) {
        lines.push(`    unexpected: ${m.unexpected.join(', ')}`);
      }
    }

    const rows = featureRowsByLeague[league];
    if (rows) {
      const fv = checkFeatureVariance(rows);
      if (!fv.skipped && fv.collapsed.length) {
        // Only alert when a collapsed feature actually carries weight.
        let weighted = new Set();
        try {
          const p = paramStore.load(league) || {};
          for (const mk of MARKETS) {
            for (const [k, v] of Object.entries(p[mk] || {})) {
              if (typeof v === 'number' && v !== 0) weighted.add(k);
            }
          }
        } catch (e) { /* leave empty */ }

        const cl = checkCollinearity(rows, weighted);
        if (!cl.skipped && cl.pairs.length) {
          alert = true;
          lines.push(`${league}: ${cl.pairs.length} WEIGHTED feature pair(s) `
            + `near-perfectly correlated (duplicated weight):`);
          for (const pr of cl.pairs.slice(0, 6)) {
            lines.push(`    ${pr.a} ~ ${pr.b}  (r=${pr.r})`);
          }
        }

        const bad = fv.collapsed.filter((c) => weighted.has(c.feature));
        if (bad.length) {
          alert = true;
          lines.push(`${league}: ${bad.length} WEIGHTED features collapsed over `
            + `${fv.games} games (< 4 distinct values):`);
          for (const c of bad.slice(0, 8)) {
            lines.push(`    ${c.feature}: ${c.distinct} distinct value(s)`);
          }
        }
      }
    }
  }

  if (!lines.length) lines.push('no leagues checked');
  return { text: lines.join('\n'), alert };
}

/**
 * Which weighted features are near-perfect copies of each other?
 *
 * This is the precise detector for the 2026-08-08 bug. recent_form_l10/l5/l3/l1
 * were formDiff * {1.0, 1.1, 1.2, 1.3} — correlation exactly 1.0. Four copies
 * of one variable carrying ~1.65 of combined weight, which is both a hidden 4x
 * on that signal AND the reason the MLB deep sweep found a flat weight space:
 * every weight vector over four copies of one variable is equivalent to a
 * single scalar, so there was nothing for the optimizer to learn.
 *
 * A low-cardinality feature is fine on its own. Two features that move
 * together perfectly are not — that is duplicated weight wearing two names.
 */
function checkCollinearity(featureRows, weightedKeys, opts = {}) {
  const threshold = opts.threshold || 0.99;
  const minGames = opts.minGames || 6;
  if (!Array.isArray(featureRows) || featureRows.length < minGames) {
    return { skipped: true, reason: `need >= ${minGames} games` };
  }

  const keys = [...(weightedKeys || [])].filter((k) => {
    const col = featureRows.map((f) => f?.[k]);
    if (!col.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    return new Set(col).size > 1; // constants have undefined correlation
  });

  const corr = (x, y) => {
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : 0;
  };

  const pairs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const r = corr(featureRows.map((f) => f[keys[i]]), featureRows.map((f) => f[keys[j]]));
      if (Math.abs(r) >= threshold) {
        pairs.push({ a: keys[i], b: keys[j], r: Number(r.toFixed(4)) });
      }
    }
  }
  pairs.sort((p, q) => Math.abs(q.r) - Math.abs(p.r));
  return { skipped: false, games: featureRows.length, pairs };
}

module.exports = {
  checkDeadWeights, checkFeatureVariance, checkCollinearity, report,
  ACCEPTED_DEAD, KNOWN_LOW_CARDINALITY,
};
