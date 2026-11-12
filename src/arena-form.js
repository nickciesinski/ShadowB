'use strict';
// =============================================================
// src/arena-form.js — short-window team form CANDIDATES (NBA / NHL)
//
// 2026-11-12. All weight 0: nothing here moves a pick or stakes a dollar. Same
// idea as src/nfl-form.js and src/form-windows.js (MLB).
//
// WHY NOW. By mid-November NBA/NHL teams have 12-15 games, so a last-5 window is
// a genuinely different quantity from the longer baseline. (NFL got these at
// week 7 with ~6 games.)
//
// WHY THESE ARE NEW. The existing recent_form_l*_diff for NBA/NHL are real
// windows, but WIN/LOSS only: a 1-point win and a 25-point win count the same.
// These use SCORES (margin), and for NHL, team save percentage.
//
// GOALIES. Tomorrow's NHL starter is usually not confirmed until warmups, long
// after Nick's 9 PM PT window, so "the starter's recent form" is not knowable
// in time. TEAM save % over its last games is: it comes straight off ESPN's
// final box (competitor.statistics `saves`, verified on the live scoreboard
// 2026-11-12). It blends starter and backup, which is what the bettor can know.
//
// SOURCE. ESPN scoreboard, one request per day (date ranges stopped working
// 2026-09-25, see arena-context.js), cached per process.
//
// TIMING — ALL PRE-GAME.
//   - Only COMPLETED regular-season games count; in-progress games are skipped.
//   - Only games whose Pacific date is BEFORE the game being predicted count.
//   - Unlike NFL, teams play on consecutive nights. At 9 PM PT a team's game
//     that same evening may not be final yet, so the 9 PM and 5:30 AM runs can
//     see one game apart. That is staleness, not a leak, and the feature-CLV
//     report only ever uses the vector that existed when the price locked.
// =============================================================

const { normTeam } = require('./arena-context');

const MAX_ABS = 3;
const SHORT = 5;          // last 5 games
const MID = 10;           // last 10 games
const LONG = 20;          // baseline the surge is measured against
const MIN_SURGE = 10;     // need history beyond the short window
const LOOKBACK_DAYS = 45; // ~20 games for both sports

const LEAGUES = {
  NBA: { path: 'basketball/nba', prefix: 'nba', margin: 10, total: 10 },
  NHL: { path: 'hockey/nhl',     prefix: 'nhl', margin: 1.5, total: 1.0 },
};

const SV_SCALE = 0.02; // 2 points of save % (.900 vs .920) = 1 unit

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function ptDate(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    : null;
}

const dayCache = new Map(); // `${path}|${yyyymmdd}` -> Promise<events[]>

function fetchDay(path, ds, fetchFn) {
  const key = `${path}|${ds}`;
  if (!dayCache.has(key)) {
    dayCache.set(key, (async () => {
      try {
        const res = await fetchFn(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ds}`);
        if (!res || !res.ok) return [];
        const json = await res.json();
        return json?.events || [];
      } catch (err) { return []; }
    })());
  }
  return dayCache.get(key);
}

function statOf(comp, name) {
  const s = (comp?.statistics || []).find((x) => x && x.name === name);
  const v = s ? parseFloat(s.displayValue) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * Every team's completed regular-season games before `gameDate`, newest first.
 * @returns {Promise<Map<string, Array<{when, pf, pa, saves}>>>} Empty on failure.
 */
async function fetchArenaForm(league, gameDate, opts = {}) {
  const cfg = LEAGUES[String(league || '').toUpperCase()];
  const out = new Map();
  if (!cfg) return out;
  const fetchFn = opts.fetch || globalThis.fetch;
  const days = opts.lookbackDays ?? LOOKBACK_DAYS;
  try {
    const anchor = new Date(`${gameDate}T12:00:00Z`).getTime();
    // Day before gameDate back `days` days. UTC dates on ESPN's side straddle
    // PT; the ptDate filter below is what actually decides inclusion.
    const dates = [];
    for (let i = 0; i <= days; i++) {
      dates.push(new Date(anchor - i * 86400000).toISOString().slice(0, 10).replace(/-/g, ''));
    }
    const lists = await Promise.all(dates.map((ds) => fetchDay(cfg.path, ds, fetchFn)));
    const seen = new Set();
    for (const ev of lists.flat()) {
      if (!ev || seen.has(ev.id)) continue;
      seen.add(ev.id);
      const comp = ev.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;
      if (ev.season?.type !== undefined && ev.season.type !== 2) continue; // regular season only
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
        out.get(key).push({ when: ev.date, pf: scores[i], pa: scores[1 - i], saves: statOf(c, 'saves') });
      });
    }
    for (const list of out.values()) list.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  } catch (err) {
    console.warn(`[arena-form] ${league} fetch failed:`, err.message);
  }
  return out;
}

/** Team save % over games: saves / (saves + goals against). Null if unknown. */
function svPct(games) {
  const ok = games.filter((g) => Number.isFinite(g.saves));
  if (ok.length < games.length || !ok.length) return null;
  const sv = ok.reduce((s, g) => s + g.saves, 0);
  const shots = sv + ok.reduce((s, g) => s + g.pa, 0);
  return shots > 0 ? sv / shots : null;
}

function summarise(games) {
  if (!games || games.length < SHORT) return null;
  const s = games.slice(0, SHORT);
  const m = games.slice(0, MID);
  const l = games.slice(0, LONG);
  return {
    n: games.length,
    marginS: avg(s.map((g) => g.pf - g.pa)),
    marginM: m.length >= MID ? avg(m.map((g) => g.pf - g.pa)) : null,
    marginL: avg(l.map((g) => g.pf - g.pa)),
    totalS: avg(s.map((g) => g.pf + g.pa)),
    totalL: avg(l.map((g) => g.pf + g.pa)),
    svS: svPct(s),
    svL: svPct(l),
  };
}

/**
 * Candidate features for one matchup. Positive favours home, except
 * *_game_pts_l5_surge, a totals signal (positive = more scoring).
 * Omitted, never zeroed, when either team lacks the games.
 */
function buildArenaFormFeatures(league, form, homeTeam, awayTeam) {
  const f = {};
  const cfg = LEAGUES[String(league || '').toUpperCase()];
  if (!cfg || !form || typeof form.get !== 'function') return f;
  const h = summarise(form.get(normTeam(homeTeam)));
  const a = summarise(form.get(normTeam(awayTeam)));
  if (!h || !a) return f;
  const p = cfg.prefix;

  f[`${p}_margin_l5_diff`] = clamp((h.marginS - a.marginS) / cfg.margin);
  if (h.marginM !== null && a.marginM !== null) {
    f[`${p}_margin_l10_diff`] = clamp((h.marginM - a.marginM) / cfg.margin);
  }

  if (h.n >= MIN_SURGE && a.n >= MIN_SURGE) {
    // The part the market may price late: recent form MINUS the longer baseline.
    f[`${p}_margin_l5_surge_diff`] = clamp(
      ((h.marginS - h.marginL) - (a.marginS - a.marginL)) / cfg.margin);
    f[`${p}_game_pts_l5_surge`] = clamp(
      (((h.totalS - h.totalL) + (a.totalS - a.totalL)) / 2) / cfg.total);
  }

  if (p === 'nhl') {
    if (h.svS !== null && a.svS !== null) {
      f.nhl_sv_l5_diff = clamp((h.svS - a.svS) / SV_SCALE);
    }
    if (h.n >= MIN_SURGE && a.n >= MIN_SURGE
        && [h.svS, h.svL, a.svS, a.svL].every((v) => v !== null)) {
      f.nhl_sv_l5_surge_diff = clamp(((h.svS - h.svL) - (a.svS - a.svL)) / SV_SCALE);
    }
  }
  return f;
}

/** Every feature name this module can emit — declared at weight 0. */
function featureNames(league) {
  const cfg = LEAGUES[String(league || '').toUpperCase()];
  if (!cfg) return [];
  const p = cfg.prefix;
  const names = [`${p}_margin_l5_diff`, `${p}_margin_l10_diff`,
    `${p}_margin_l5_surge_diff`, `${p}_game_pts_l5_surge`];
  if (p === 'nhl') names.push('nhl_sv_l5_diff', 'nhl_sv_l5_surge_diff');
  return names;
}

module.exports = {
  fetchArenaForm,
  buildArenaFormFeatures,
  summarise,
  svPct,
  featureNames,
  ptDate,
  LEAGUES,
  SHORT, MID, LONG, MIN_SURGE, MAX_ABS,
  _dayCache: dayCache,
};
