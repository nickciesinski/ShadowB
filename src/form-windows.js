'use strict';
// =============================================================
// src/form-windows.js — short-window team form (MLB)
//
// 2026-09-11. A batch of CANDIDATE features: every one declared at weight 0, so
// none of them moves a pick or stakes a dollar. See src/bullpen-fatigue.js and
// the candidate path in game-features.js decomposeScore().
//
// THE IDEA. The model's existing features are SEASON-LONG aggregates — season
// OPS, season WHIP, season run differential. Those measure r≈0 against CLV not
// because they fail to predict baseball but because every public model has them
// and the closing line already contains them. A feature can only earn a weight
// by carrying something the market prices LATE.
//
// The cheapest source of that is the same statistic over a SHORT window. Team
// OPS over the last 7 days is a different quantity from season OPS: noisier,
// but far less thoroughly priced, and it moves on exactly the timescale a
// betting line drifts. This is a hypothesis. It may measure zero like the rest;
// that is what the candidate mechanism is for.
//
// WHY THIS SHAPE. Two HTTP calls per window (hitting + pitching) return all 30
// teams, so a 7- and 14-day pair is four requests for the whole slate. The
// per-game boxscore route would be ~45 calls a night for less.
//
// TIMING. Windows END YESTERDAY. Today's games have not been played, and
// including the current date would pull in partial results from games already
// under way — a leak, and a subtle one, because it would only appear on days
// with early starts. Nick bets at ~9 PM PT the night before or ~5:30 AM PT the
// morning of; both are after the previous day's games are final, so the same
// window is available and identical in both of his windows. That matters: a
// feature whose value changes between 9 PM and 5:30 AM could flip a pick, and a
// pick that flips is the one thing he has ruled out.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');

// Each row: [featureSuffix, group, statKey, unitScale, higherIsBetter]
//
// unitScale is "how much of this stat is one unit of feature", chosen so a
// weight here would be comparable to the season-long weights already in
// config/model-params.MLB.json (ops_diff / 0.1, whip_diff / 0.15).
//
// higherIsBetter false means the diff is inverted (away minus home) so that
// POSITIVE ALWAYS FAVOURS HOME — the house convention, same as whip_diff.
const SPEC = [
  // ── hitting ──
  ['ops',        'hitting',  'ops',            0.10,  true],
  ['avg',        'hitting',  'avg',            0.02,  true],
  ['obp',        'hitting',  'obp',            0.03,  true],
  ['slg',        'hitting',  'slg',            0.06,  true],
  ['babip',      'hitting',  'babip',          0.03,  true],
  ['runs_pg',    'hitting',  '@runsPerGame',   1.00,  true],
  ['hr_pg',      'hitting',  '@hrPerGame',     0.50,  true],
  ['k_rate',     'hitting',  '@kRate',         0.05,  false], // striking out is bad
  ['bb_rate',    'hitting',  '@bbRate',        0.03,  true],
  // ── pitching ──
  ['era',        'pitching', 'era',            1.00,  false],
  ['whip',       'pitching', 'whip',           0.15,  false],
  ['k9',         'pitching', '@k9',            1.50,  true],
  ['bb9',        'pitching', '@bb9',           1.00,  false],
  ['hr9',        'pitching', '@hr9',           0.40,  false],
];

// Same guard as mlb_run_diff and bullpen_fatigue_diff: a plausible value sits
// well inside +/-3, and anything past it is upstream corruption rather than a
// hot team. Letting an unbounded value through is how a feature ran at -5825.
const MAX_ABS = 3;

/** ".757" and "54.0" both arrive as strings. */
function num(v) {
  if (v === null || v === undefined || v === '' || v === '-.--' || v === '.---') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Rate stats StatsAPI does not return directly. */
function derive(key, st) {
  const ip = num(st.inningsPitched);
  const g = num(st.gamesPlayed);
  const pa = num(st.plateAppearances);
  switch (key) {
    case '@runsPerGame': return (g && g > 0) ? num(st.runs) / g : null;
    case '@hrPerGame':   return (g && g > 0) ? num(st.homeRuns) / g : null;
    case '@kRate':       return (pa && pa > 0) ? num(st.strikeOuts) / pa : null;
    case '@bbRate':      return (pa && pa > 0) ? num(st.baseOnBalls) / pa : null;
    case '@k9':          return (ip && ip > 0) ? (num(st.strikeOuts) * 9) / ip : null;
    case '@bb9':         return (ip && ip > 0) ? (num(st.baseOnBalls) * 9) / ip : null;
    case '@hr9':         return (ip && ip > 0) ? (num(st.homeRuns) * 9) / ip : null;
    default:             return null;
  }
}

function statValue(key, st) {
  if (!st) return null;
  return key.startsWith('@') ? derive(key, st) : num(st[key]);
}

// Dates are PACIFIC, not UTC, and this is load-bearing.
//
// The slate build fires at 02:00 UTC, which is 7 PM PT the PREVIOUS day. A
// UTC-based "yesterday" there resolves to the day whose games are still being
// played, so the window would scoop up partial, in-progress results — a leak
// that would only appear on days with late starts, i.e. the hardest kind to
// notice. In Pacific terms 7 PM PT on the 11th has "yesterday" = the 10th,
// whose games are final.
//
function ptDaysAgo(days, from = new Date()) {
  const shifted = new Date(from.getTime() - days * 86400000);
  // en-CA renders as YYYY-MM-DD.
  return shifted.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** Today in Pacific, as YYYY-MM-DD. */
function ptToday(from = new Date()) {
  return from.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Window bounds for a slate played on `gameDate`, ending the day before it.
 *
 * ANCHORED TO THE GAME DATE, NOT TO THE CLOCK — this is the whole point.
 * Anchoring to "now" made the same slate resolve to different windows in Nick's
 * two betting windows: 9 PM PT on the 11th ended the window on the 10th, while
 * 5:30 AM PT on the 12th ended it on the 11th. Same games, different inputs,
 * and therefore a pick that could disagree with itself between the only two
 * times he can actually bet. Anchoring to the game date makes both resolve to
 * game-date-minus-one and agree exactly, no matter when the slate is built or
 * rebuilt.
 *
 * @param {string} gameDate YYYY-MM-DD, Pacific
 * @param {number} days     window length
 */
function windowFor(gameDate, days) {
  const anchor = new Date(`${gameDate}T12:00:00Z`); // midday avoids DST edges
  return { startDate: ptDaysAgo(days, anchor), endDate: ptDaysAgo(1, anchor) };
}

/**
 * All 30 teams' stats for one group over one date window.
 *
 * @returns {Promise<Map<string, object>>} normalised team name -> stat object.
 *          Empty Map on any failure: an absent feature must read as absent, not
 *          as a confident zero.
 */
async function fetchTeamWindow(group, startDate, endDate, fetchFn = globalThis.fetch) {
  const url = `https://statsapi.mlb.com/api/v1/teams/stats?season=${startDate.slice(0, 4)}`
    + `&group=${group}&stats=byDateRange&startDate=${startDate}&endDate=${endDate}`
    + `&sportId=1&gameType=R`;
  const out = new Map();
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) {
      console.warn(`[form-windows] HTTP ${res && res.status} ${group} ${startDate}..${endDate}`);
      return out;
    }
    const json = await res.json();
    for (const s of (json?.stats?.[0]?.splits || [])) {
      if (s?.team?.name) out.set(normTeam(s.team.name), s.stat || {});
    }
  } catch (err) {
    console.warn(`[form-windows] ${group} fetch failed:`, err.message);
  }
  return out;
}

/**
 * Fetch every window. `windows` maps a feature-name suffix to a day count.
 *
 * @returns {Promise<object>} { l7: { hitting: Map, pitching: Map }, ... }
 */
async function fetchFormWindows(opts = {}) {
  const windows = opts.windows || { l7: 7, l14: 14 };
  const fetchFn = opts.fetch || globalThis.fetch;
  // The slate's game date, Pacific. Defaults to today only as a fallback; the
  // caller should pass the date the games are actually played on.
  const gameDate = opts.gameDate || ptToday(opts.now || new Date());
  const out = {};
  for (const [label, days] of Object.entries(windows)) {
    const { startDate, endDate } = windowFor(gameDate, days);
    const [hitting, pitching] = await Promise.all([
      fetchTeamWindow('hitting', startDate, endDate, fetchFn),
      fetchTeamWindow('pitching', startDate, endDate, fetchFn),
    ]);
    out[label] = { hitting, pitching, startDate, endDate };
  }
  return out;
}

/**
 * Turn fetched windows into candidate features for one matchup.
 *
 * Names are `<stat>_<window>_diff`, e.g. ops_l7_diff. A feature is OMITTED when
 * either side is missing rather than set to 0 — 0 asserts the teams are equal,
 * which is a claim; absence is the truth and the candidate machinery records it
 * as unmeasured for that game.
 */
function buildFormFeatures(windows, homeTeam, awayTeam) {
  const f = {};
  if (!windows) return f;
  const hk = normTeam(homeTeam), ak = normTeam(awayTeam);
  if (!hk || !ak) return f;

  for (const [label, w] of Object.entries(windows)) {
    if (!w) continue;
    for (const [suffix, group, statKey, scale, higherIsBetter] of SPEC) {
      const table = w[group];
      if (!table || typeof table.get !== 'function') continue;
      const hv = statValue(statKey, table.get(hk));
      const av = statValue(statKey, table.get(ak));
      if (hv === null || av === null) continue;
      const raw = (higherIsBetter ? hv - av : av - hv) / scale;
      if (!Number.isFinite(raw)) continue;
      f[`${suffix}_${label}_diff`] = Math.max(-MAX_ABS, Math.min(MAX_ABS, raw));
    }
  }
  return f;
}

/** Every feature name this module can emit — used to declare them at weight 0. */
function featureNames(windowLabels = ['l7', 'l14']) {
  const names = [];
  for (const label of windowLabels) {
    for (const [suffix] of SPEC) names.push(`${suffix}_${label}_diff`);
  }
  return names;
}

module.exports = {
  ptDaysAgo,
  ptToday,
  windowFor,
  fetchFormWindows,
  fetchTeamWindow,
  buildFormFeatures,
  featureNames,
  SPEC,
  MAX_ABS,
};
