'use strict';
// =============================================================
// src/bullpen-fatigue.js — how much work a team's relievers have just done
//
// 2026-09-10. A CANDIDATE feature: declared at weight 0, so it moves no pick
// and stakes no money. It exists to start accumulating a measurable record
// against CLV now, because the one thing that cannot be bought later is
// elapsed days. See the candidate path in game-features.js decomposeScore().
//
// WHY THIS ONE. The existing 27 features are season-long team and pitcher
// aggregates — run differential, OPS, WHIP, ERA. Every public model has them,
// which is why they measure r≈0 against CLV: the closing line already contains
// them. A feature can only earn its weight by carrying something the market
// prices LATE. Recent bullpen usage is a plausible candidate for that: it is
// public but tedious to compute, it decays within days, and it is the kind of
// thing a line moves on when a beat writer mentions it at 4pm.
//
// This is a hypothesis, not a finding. It may well measure zero like the rest.
//
// WHY RELIEF-ONLY, NOT TOTAL PITCHES. Total staff workload has the wrong sign
// built into it: a starter going deep is a LOT of pitches and a RESTED bullpen.
// Summing everything would blend those two opposite states into one number.
// Only pitchers with gamesStarted == 0 in the window are counted.
//
// NO LEAK. Everything here comes from games that have already finished. The
// umpire feature considered alongside this one was dropped for exactly that
// reason: MLB publishes officials only AFTER the game (verified 2026-09-10 —
// 0 of 15 games had them the day before, 15 of 15 did afterwards), so a model
// using them would have been reading information that did not exist when the
// pick was made. A backtest on that would look excellent and earn nothing.
// =============================================================

const DEFAULT_WINDOW_DAYS = 3;

// One unit of the feature. ~50 relief pitches is roughly one heavy outing, so a
// team a full appearance more tired than its opponent reads as 1.0. Chosen to
// sit on the same scale as the other *_diff features (ops_diff / 0.1,
// whip_diff / 0.15), which keeps any future weight comparable to theirs.
const PITCHES_PER_UNIT = 50;

// Same guard as mlb_run_diff: a plausible value is well inside +/-3. Anything
// past that is upstream corruption (a missing team, a doubleheader counted
// twice), and letting it through is how a feature ran at -5825 for months.
const MAX_ABS = 3;

/** StatsAPI and the odds feed disagree on some names ("Athletics"). */
function normTeam(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function isoDaysAgo(days, from = new Date()) {
  const d = new Date(from.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Relief pitches thrown by each team over a date window.
 *
 * One request for all 30 teams. The per-game boxscore route would need ~45
 * calls a night for the same answer.
 *
 * @returns {Promise<Map<string, {reliefPitches:number, appearances:number, team:string}>>}
 *          keyed by normalised team name; empty Map on any failure — a missing
 *          feature must read as absent, never as zero fatigue.
 */
async function fetchBullpenLoad(opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  // Yesterday backwards. Today's games have not been played, and including the
  // current date would pull in results from games already under way.
  const endDate = opts.endDate || isoDaysAgo(1);
  const startDate = opts.startDate || isoDaysAgo(windowDays);
  const fetchFn = opts.fetch || globalThis.fetch;

  const url = `https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=pitching`
    + `&startDate=${startDate}&endDate=${endDate}&sportId=1&playerPool=ALL&limit=1500`;

  const out = new Map();
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) {
      console.warn(`[bullpen-fatigue] HTTP ${res && res.status} for ${startDate}..${endDate}`);
      return out;
    }
    const json = await res.json();
    const splits = json?.stats?.[0]?.splits || [];
    for (const s of splits) {
      const st = s.stat || {};
      // A reliever in THIS window: appeared, never started. A swingman who
      // started once in the window is excluded rather than half-counted —
      // his pitches are mostly starter pitches.
      if (Number(st.gamesStarted || 0) !== 0) continue;
      const teamName = s.team?.name;
      if (!teamName) continue;
      const key = normTeam(teamName);
      const prev = out.get(key) || { reliefPitches: 0, appearances: 0, team: teamName };
      prev.reliefPitches += Number(st.numberOfPitches || 0) || 0;
      prev.appearances += Number(st.gamesPlayed || 0) || 0;
      out.set(key, prev);
    }
  } catch (err) {
    console.warn('[bullpen-fatigue] fetch failed:', err.message);
    return new Map();
  }
  return out;
}

/**
 * The feature value for one matchup.
 *
 * Sign follows the house convention that POSITIVE FAVOURS HOME. More relief
 * work is worse, so this is away-minus-home — the same inversion whip_diff
 * uses for a lower-is-better stat.
 *
 * @returns {number|null} null when either team is missing, so the candidate is
 *          recorded as absent rather than as a confident 0.
 */
function bullpenFatigueDiff(load, homeTeam, awayTeam) {
  if (!load || typeof load.get !== 'function') return null;
  const h = load.get(normTeam(homeTeam));
  const a = load.get(normTeam(awayTeam));
  if (!h || !a) return null;
  const raw = (a.reliefPitches - h.reliefPitches) / PITCHES_PER_UNIT;
  if (!Number.isFinite(raw)) return null;
  if (Math.abs(raw) > MAX_ABS) {
    console.log(`[bullpen-fatigue] implausible diff ${raw.toFixed(2)} `
      + `(${awayTeam} ${a.reliefPitches} vs ${homeTeam} ${h.reliefPitches}) — clamped`);
    return raw > 0 ? MAX_ABS : -MAX_ABS;
  }
  return raw;
}

module.exports = {
  fetchBullpenLoad,
  bullpenFatigueDiff,
  normTeam,
  PITCHES_PER_UNIT,
  DEFAULT_WINDOW_DAYS,
};
