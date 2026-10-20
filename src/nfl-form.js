'use strict';
// =============================================================
// src/nfl-form.js — short-window team form CANDIDATES (NFL)
//
// 2026-10-20. All weight 0: nothing here moves a pick or stakes a dollar. See
// CLAUDE.md and src/form-windows.js (the MLB version of the same idea).
//
// WHY NOW. src/nfl-context.js deliberately skipped form windows in week 1:
// "last 7 days" was one game. At week 7 a team has 5-6 games, so a last-3
// window is a genuinely different quantity from the season figure.
//
// WHY THESE ARE NEW. The existing recent_form_l1/l3/l5/l10_diff are NOT short
// windows for NFL. data-collection.js only fills formL1/L3/L5 for some leagues;
// for NFL they are blank, so all four fall back to the same season win-pct
// figure (r = 1.000 with each other in the 2026-10-18 report). Short-window NFL
// form has never actually been measured. These are built from game SCORES, not
// win/loss, because a 3-game win rate only takes four values.
//
// SOURCE. ESPN's scoreboard by week (seasontype=2): one call returns a whole
// week with final scores, so the full season is at most 18 calls, cached for
// the run. A week call is used rather than fetchEspnDays because the window
// is counted in games, not days, and NFL games sit on 3-4 days of each week.
//
// TIMING — ALL PRE-GAME, AND STABLE ACROSS NICK'S TWO WINDOWS.
//   - Only COMPLETED regular-season games count. A game in progress is skipped,
//     never read as a partial score.
//   - Only games whose Pacific date is BEFORE the game being predicted count.
//     Anchored to the game date, not the clock (same lesson as form-windows).
//   - No NFL team plays on consecutive days, so a team's previous game is final
//     well before 9 PM PT the night before and 5:30 AM PT the morning of. Both
//     windows therefore see the same games and the same values.
//   - Picks lock early (all of next week on Sunday evening, see nfl-week.js).
//     At that lock a team's most recent game may not be played yet; the vector
//     simply uses the games that ARE final. That is staleness, not a leak, and
//     the feature-CLV report only uses lock-time vectors.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');

const MAX_ABS = 3;
const WINDOW = 3;          // last 3 games
const MIN_SEASON = 4;      // the surge features need history beyond the window
const MAX_WEEKS = 18;

const SCALE = {
  margin: 10,   // 10 points of average margin = 1 unit
  points: 7,    // a touchdown a game = 1 unit
};

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));

/** Pacific calendar date (YYYY-MM-DD) of an ISO instant. */
function ptDate(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    : null;
}

// One season of weeks per process. Each slate build is its own process, so
// this never serves a stale score across runs.
const weekCache = new Map(); // `${season}-${week}` -> Promise<events[]>

async function fetchWeek(season, week, fetchFn) {
  const key = `${season}-${week}`;
  if (!weekCache.has(key)) {
    weekCache.set(key, (async () => {
      try {
        const res = await fetchFn('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
          + `?seasontype=2&week=${week}&dates=${season}`);
        if (!res || !res.ok) return [];
        const json = await res.json();
        return json?.events || [];
      } catch (err) {
        console.warn(`[nfl-form] week ${week} fetch failed:`, err.message);
        return [];
      }
    })());
  }
  return weekCache.get(key);
}

/**
 * Every team's completed regular-season games before `gameDate`, newest first.
 *
 * @returns {Promise<Map<string, Array<{when, pf, pa}>>>} normTeam -> games.
 *          Empty Map on failure: an absent feature must read as absent.
 */
async function fetchNflForm(gameDate, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  // The NFL season is named for the year it starts; January games belong to
  // the previous year's season.
  const y = Number(gameDate.slice(0, 4));
  const season = Number(gameDate.slice(5, 7)) <= 3 ? y - 1 : y;
  const out = new Map();
  try {
    const weeks = await Promise.all(
      Array.from({ length: MAX_WEEKS }, (_, i) => fetchWeek(season, i + 1, fetchFn)));
    for (const ev of weeks.flat()) {
      const comp = ev?.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;
      if (ev?.season?.type !== undefined && ev.season.type !== 2) continue;
      const d = ptDate(ev.date);
      if (!d || d >= gameDate) continue;
      const cs = comp.competitors || [];
      if (cs.length !== 2) continue;
      const scores = cs.map((c) => parseFloat(c?.score));
      if (!scores.every(Number.isFinite)) continue;
      cs.forEach((c, i) => {
        const name = c?.team?.displayName;
        if (!name) return;
        const key = normTeam(name);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push({ when: ev.date, pf: scores[i], pa: scores[1 - i] });
      });
    }
    for (const list of out.values()) list.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  } catch (err) {
    console.warn('[nfl-form] fetch failed:', err.message);
  }
  return out;
}

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Window and season averages for one team, or null if too few games. */
function summarise(games) {
  if (!games || games.length < WINDOW) return null;
  const w = games.slice(0, WINDOW);
  return {
    n: games.length,
    pfL3: avg(w.map((g) => g.pf)),
    paL3: avg(w.map((g) => g.pa)),
    marginL3: avg(w.map((g) => g.pf - g.pa)),
    totalL3: avg(w.map((g) => g.pf + g.pa)),
    marginSeason: avg(games.map((g) => g.pf - g.pa)),
    totalSeason: avg(games.map((g) => g.pf + g.pa)),
  };
}

/**
 * Candidate features for one matchup. Positive favours home, except
 * nfl_game_pts_l3_surge, which is a totals signal (positive = more points).
 *
 * Omitted, never zeroed, when either team lacks the games.
 */
function buildNflFormFeatures(form, homeTeam, awayTeam) {
  const f = {};
  if (!form || typeof form.get !== 'function') return f;
  const h = summarise(form.get(normTeam(homeTeam)));
  const a = summarise(form.get(normTeam(awayTeam)));
  if (!h || !a) return f;

  f.nfl_margin_l3_diff = clamp((h.marginL3 - a.marginL3) / SCALE.margin);
  f.nfl_pf_l3_diff = clamp((h.pfL3 - a.pfL3) / SCALE.points);
  // Points allowed: fewer is better, so away minus home.
  f.nfl_pa_l3_diff = clamp((a.paL3 - h.paL3) / SCALE.points);

  // The part the market may price late: recent form MINUS what the season
  // already says. Needs games beyond the window or it is just L3 minus itself.
  if (h.n >= MIN_SEASON && a.n >= MIN_SEASON) {
    f.nfl_margin_l3_surge_diff = clamp(
      ((h.marginL3 - h.marginSeason) - (a.marginL3 - a.marginSeason)) / SCALE.margin);
    // A real totals candidate, not a home-minus-away difference: are both
    // teams' recent games higher-scoring than their season so far?
    f.nfl_game_pts_l3_surge = clamp(
      (((h.totalL3 - h.totalSeason) + (a.totalL3 - a.totalSeason)) / 2) / SCALE.points);
  }
  return f;
}

/** Every feature name this module can emit — used to declare them at weight 0. */
function featureNames() {
  return [
    'nfl_margin_l3_diff',
    'nfl_pf_l3_diff',
    'nfl_pa_l3_diff',
    'nfl_margin_l3_surge_diff',
    'nfl_game_pts_l3_surge',
  ];
}

module.exports = {
  fetchNflForm,
  buildNflFormFeatures,
  summarise,
  featureNames,
  ptDate,
  SCALE,
  WINDOW,
  MIN_SEASON,
  MAX_ABS,
  _weekCache: weekCache,
};
