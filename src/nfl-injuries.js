'use strict';
// =============================================================
// src/nfl-injuries.js — NFL injury-report CANDIDATES (weight 0)
//
// 2026-09-12. Nothing here moves a pick. See CLAUDE.md for the rules every
// candidate must satisfy.
//
// WHY THIS IS NOT THE INJURY FEATURES THE MODEL ALREADY HAS. game-features.js
// already produces home_injury_weight / injury_weight_diff / severe_injury_
// factor from injury-impact.js, which scores a player by TIER (S/A/B/C/D) and
// sums. That is a sport-agnostic measure and it is the right shape for
// basketball, where five players share the floor and any starter missing is
// roughly a fifth of the lineup.
//
// Football is not shaped like that. One position dominates everything: a
// starting quarterback ruled out moves a spread several points, and no other
// single injury comes close. A tier-sum treats a quarterback and a safety as
// comparable quantities scaled by how good each player is, which is the wrong
// model of the sport. These features split the report by POSITION GROUP and by
// DESIGNATION instead.
//
// WHY THE TIMING WORKS. NFL injury reports run on a fixed published schedule —
// practice participation Wednesday through Friday, final game-status
// designations Friday afternoon for a Sunday game. Every one of those lands
// well before Nick's 9 PM PT Saturday window, and nothing here needs inactives,
// which post 90 minutes before kickoff and would be far too late.
//
// WHAT THIS CANNOT SEE, stated plainly: ESPN's injury feed does not say who is
// a STARTER. A quarterback listed Out may be the third-stringer. Reading a
// depth chart would take 32 more requests per run and introduces its own
// staleness, so the first version accepts the noise — with the note that it
// biases every feature here toward zero rather than toward a false signal,
// which is the safe direction for something being measured before it is
// trusted.
//
// INJURED RESERVE AND SUSPENSIONS ARE EXCLUDED. Both are known weeks ahead and
// are already reflected in the team's recent performance, so counting them
// would double-count a fact the season stats contain. What moves a line is THIS
// WEEK's report: Out, Doubtful, Questionable.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');

const MAX_ABS = 3;

// Rough relative game impact by position. These are not fitted — they are a
// deliberately coarse prior, because the whole point is to let CLV decide
// whether the grouping carries information at all before anyone tunes it.
const POSITION_WEIGHT = {
  QB: 1.00,
  OT: 0.30, T: 0.30, LT: 0.30, RT: 0.30,
  WR: 0.25, CB: 0.25, DE: 0.25, EDGE: 0.25,
  G: 0.20, OG: 0.20, C: 0.20, RB: 0.20,
  TE: 0.18, S: 0.18, FS: 0.18, SS: 0.18, DT: 0.18,
  LB: 0.15, ILB: 0.15, OLB: 0.15, MLB: 0.15,
  FB: 0.08, K: 0.05, P: 0.05, LS: 0.02,
};
const DEFAULT_POSITION_WEIGHT = 0.10;

// How much of a player's impact to count, given his designation. Questionable
// is genuinely ambiguous — historically a little better than a coin flip to
// play — so it is discounted hard rather than treated as an absence.
const STATUS_WEIGHT = {
  out: 1.00,
  doubtful: 0.75,
  questionable: 0.35,
};

// Deliberately absent: 'injured reserve', 'suspension', 'active'. See header.

const GROUPS = {
  skill: ['WR', 'RB', 'TE', 'FB'],
  oline: ['OT', 'T', 'LT', 'RT', 'G', 'OG', 'C'],
  secondary: ['CB', 'S', 'FS', 'SS'],
  frontseven: ['DE', 'EDGE', 'DT', 'LB', 'ILB', 'OLB', 'MLB'],
};

const SCALE = {
  weighted: 1.0,   // 1.0 of position-weighted absence = 1 unit
  count: 3.0,      // 3 players = 1 unit
  group: 1.0,
};

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));

/**
 * Per-team injury summary from the ESPN NFL feed.
 *
 * @returns {Promise<Map<string, object>>} normalised team -> summary.
 *          Empty Map on failure: absent must read as absent, not as healthy.
 */
async function fetchNflInjuries(opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
  const out = new Map();
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) {
      console.warn('[nfl-injuries] HTTP', res && res.status);
      return out;
    }
    const json = await res.json();
    for (const team of (json?.injuries || [])) {
      const name = team?.displayName || team?.team?.displayName;
      if (!name) continue;
      const summary = {
        weighted: 0, outCount: 0, questionableCount: 0, qbImpact: 0,
        skill: 0, oline: 0, secondary: 0, frontseven: 0,
      };
      for (const inj of (team?.injuries || [])) {
        const status = String(inj?.status || '').toLowerCase();
        const sw = STATUS_WEIGHT[status];
        if (!sw) continue; // Active / IR / Suspension — see header
        const pos = String(
          (inj?.athlete?.position?.abbreviation) || '').toUpperCase();
        const pw = POSITION_WEIGHT[pos] ?? DEFAULT_POSITION_WEIGHT;
        const impact = pw * sw;

        summary.weighted += impact;
        if (status === 'out') summary.outCount += 1;
        if (status === 'questionable') summary.questionableCount += 1;
        // A team can only lose ONE starting quarterback. Summing gives Atlanta
        // 2.00 when QB1 and QB3 are both listed, which overstates a backup's
        // absence as if it were a second franchise QB going down. Taking the
        // max keeps the worst single designation and caps the feature at 1.
        if (pos === 'QB') summary.qbImpact = Math.max(summary.qbImpact, sw);
        for (const [g, list] of Object.entries(GROUPS)) {
          if (list.includes(pos)) summary[g] += impact;
        }
      }
      out.set(normTeam(name), summary);
    }
  } catch (err) {
    console.warn('[nfl-injuries] fetch failed:', err.message);
  }
  return out;
}

/**
 * Candidate features for one matchup. Positive favours home throughout, which
 * for injuries means AWAY-minus-HOME: the away team being hurt is good for home.
 *
 * Omitted, never zeroed, when a team is absent from the feed — 0 would assert
 * "both teams fully healthy", which is a claim.
 */
function buildInjuryFeatures(injuries, homeTeam, awayTeam) {
  const f = {};
  if (!injuries || typeof injuries.get !== 'function') return f;
  const h = injuries.get(normTeam(homeTeam));
  const a = injuries.get(normTeam(awayTeam));
  if (!h || !a) return f;

  f.nfl_injury_weighted_diff = clamp((a.weighted - h.weighted) / SCALE.weighted);
  f.nfl_qb_out_diff = clamp(a.qbImpact - h.qbImpact);
  f.nfl_out_count_diff = clamp((a.outCount - h.outCount) / SCALE.count);
  f.nfl_questionable_diff = clamp((a.questionableCount - h.questionableCount) / SCALE.count);
  f.nfl_skill_out_diff = clamp((a.skill - h.skill) / SCALE.group);
  f.nfl_oline_out_diff = clamp((a.oline - h.oline) / SCALE.group);
  f.nfl_secondary_out_diff = clamp((a.secondary - h.secondary) / SCALE.group);
  f.nfl_frontseven_out_diff = clamp((a.frontseven - h.frontseven) / SCALE.group);
  return f;
}

function featureNames() {
  return [
    'nfl_injury_weighted_diff',
    'nfl_qb_out_diff',
    'nfl_out_count_diff',
    'nfl_questionable_diff',
    'nfl_skill_out_diff',
    'nfl_oline_out_diff',
    'nfl_secondary_out_diff',
    'nfl_frontseven_out_diff',
  ];
}

module.exports = {
  fetchNflInjuries,
  buildInjuryFeatures,
  featureNames,
  POSITION_WEIGHT,
  STATUS_WEIGHT,
  GROUPS,
  SCALE,
  MAX_ABS,
};
