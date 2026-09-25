'use strict';
// =============================================================
// src/nfl-context.js — rest, travel and body clock CANDIDATES (NFL)
//
// 2026-09-11. All weight 0: nothing here moves a pick. See CLAUDE.md.
//
// WHY NFL GETS REST AND TRAVEL BUT NOT FORM WINDOWS. In a 17-game season the
// schedule itself is one of the largest legitimate signals available: a team on
// four days' rest after a Sunday-to-Thursday turnaround is measurably not the
// same team, and the gap between a short week and a post-bye fortnight is the
// widest rest asymmetry in any of the four sports. Meanwhile short-window form
// is meaningless here — "last 7 days" is one game, and this season is a week
// old. Form windows are deliberately NOT ported from src/form-windows.js; they
// would be a noisier copy of the season stats the model already has.
//
// WHY A COORDINATE TABLE. ESPN exposes NFL venues as city/state only, with no
// latitude or longitude (verified 2026-09-11), unlike MLB's StatsAPI which
// carries both. The table below is static because stadiums are: it is checked
// against the league's 32 home cities, and distances only feed a 1500-mile
// scale, so city-centre precision is far finer than the feature needs. Time
// zones are the part that must be exact, and those are a property of the city
// rather than the stadium, so they are safe to table.
//
// ALL PRE-GAME. Kickoff times and the schedule are published weeks ahead; the
// previous game is by definition complete. Nothing here requires anything that
// appears after kickoff.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');

const MAX_ABS = 3;

const SCALE = {
  restDays: 3.0,    // 3 days of rest difference = 1 unit (short week vs normal)
  distance: 1500,
  tzShift: 2.0,
};

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));

// [lat, lon, IANA zone]. Keyed by normalised ESPN displayName.
// London/Munich games are handled as neutral sites by the caller, not here.
const VENUES = {
  arizonacardinals:      [33.5277, -112.2626, 'America/Phoenix'],
  atlantafalcons:        [33.7554, -84.4008,  'America/New_York'],
  baltimoreravens:       [39.2780, -76.6227,  'America/New_York'],
  buffalobills:          [42.7738, -78.7870,  'America/New_York'],
  carolinapanthers:      [35.2258, -80.8528,  'America/New_York'],
  chicagobears:          [41.8623, -87.6167,  'America/Chicago'],
  cincinnatibengals:     [39.0955, -84.5161,  'America/New_York'],
  clevelandbrowns:       [41.5061, -81.6995,  'America/New_York'],
  dallascowboys:         [32.7473, -97.0945,  'America/Chicago'],
  denverbroncos:         [39.7439, -105.0201, 'America/Denver'],
  detroitlions:          [42.3400, -83.0456,  'America/New_York'],
  greenbaypackers:       [44.5013, -88.0622,  'America/Chicago'],
  houstontexans:         [29.6847, -95.4107,  'America/Chicago'],
  indianapoliscolts:     [39.7601, -86.1639,  'America/Indiana/Indianapolis'],
  jacksonvillejaguars:   [30.3239, -81.6373,  'America/New_York'],
  kansascitychiefs:      [39.0489, -94.4839,  'America/Chicago'],
  lasvegasraiders:       [36.0909, -115.1833, 'America/Los_Angeles'],
  losangeleschargers:    [33.9535, -118.3392, 'America/Los_Angeles'],
  losangelesrams:        [33.9535, -118.3392, 'America/Los_Angeles'],
  miamidolphins:         [25.9580, -80.2389,  'America/New_York'],
  minnesotavikings:      [44.9738, -93.2578,  'America/Chicago'],
  newenglandpatriots:    [42.0909, -71.2643,  'America/New_York'],
  neworleanssaints:      [29.9511, -90.0812,  'America/Chicago'],
  newyorkgiants:         [40.8135, -74.0745,  'America/New_York'],
  newyorkjets:           [40.8135, -74.0745,  'America/New_York'],
  philadelphiaeagles:    [39.9008, -75.1675,  'America/New_York'],
  pittsburghsteelers:    [40.4468, -80.0158,  'America/New_York'],
  sanfrancisco49ers:     [37.4030, -121.9698, 'America/Los_Angeles'],
  seattleseahawks:       [47.5952, -122.3316, 'America/Los_Angeles'],
  tampabaybuccaneers:    [27.9759, -82.5033,  'America/New_York'],
  tennesseetitans:       [36.1665, -86.7713,  'America/Chicago'],
  washingtoncommanders:  [38.9077, -76.8645,  'America/New_York'],
};

// Keys are normalised through normTeam at load, not trusted as written.
// normTeam strips digits, so "San Francisco 49ers" becomes "sanfranciscoers" —
// a literal key of "sanfrancisco49ers" silently never matched, and the only
// symptom was one team quietly missing every travel feature.
const VENUE_INDEX = new Map(
  Object.entries(VENUES).map(([k, v]) => [normTeam(k), v]));

function venueFor(team) {
  const v = VENUE_INDEX.get(normTeam(team));
  return v ? { lat: v[0], lon: v[1], tz: v[2] } : null;
}

const { haversineMiles, tzOffsetHours } = require('./travel-context');
const { fetchEspnDays } = require('./arena-context');

/**
 * Previous game per team from the ESPN scoreboard, over a week window.
 *
 * ESPN's NFL scoreboard is queried one day at a time (see fetchEspnDays in
 * arena-context.js for why not a date range). Only events STRICTLY BEFORE the game date count —
 * an event on the slate date is the one being predicted, and using it as its
 * own previous game would be circular.
 */
async function fetchPreviousGames(gameDate, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const lookbackDays = opts.lookbackDays ?? 21; // covers a bye week plus slack
  const end = new Date(`${gameDate}T12:00:00Z`);
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const out = new Map(); // normTeam -> { when, venueTeam }
  try {
    const events = await fetchEspnDays('football/nfl', start, end, fetchFn);
    for (const ev of events) {
      const when = ev?.date;
      if (!when || String(when).slice(0, 10) >= gameDate) continue;
      const comp = ev?.competitions?.[0];
      for (const c of (comp?.competitors || [])) {
        const name = c?.team?.displayName;
        if (!name) continue;
        const key = normTeam(name);
        const prev = out.get(key);
        if (!prev || String(when) > String(prev.when)) {
          // Where that game was played = the home competitor's venue.
          const homeComp = (comp.competitors || []).find((x) => x.homeAway === 'home');
          out.set(key, { when, venueTeam: homeComp?.team?.displayName || null });
        }
      }
    }
  } catch (err) {
    console.warn('[nfl-context] previous games fetch failed:', err.message);
  }
  return out;
}

async function fetchNflContext(gameDate, opts = {}) {
  const previous = await fetchPreviousGames(gameDate, opts);
  return { gameDate, previous };
}

/**
 * Candidate features for one NFL matchup. Positive favours home.
 *
 * Omitted, never zeroed, when inputs are unknown.
 */
function buildNflFeatures(ctx, homeTeam, awayTeam, kickoffISO) {
  const f = {};
  if (!ctx) return f;
  const venue = venueFor(homeTeam);
  const awayHome = venueFor(awayTeam);
  if (!venue) return f;

  // Body clock: positive = away travelled east into a later body time.
  if (awayHome) {
    const vOff = tzOffsetHours(venue.tz, ctx.gameDate);
    const aOff = tzOffsetHours(awayHome.tz, ctx.gameDate);
    if (vOff !== null && aOff !== null) {
      f.nfl_tz_shift_diff = clamp((vOff - aOff) / SCALE.tzShift);
    }
  }

  const hPrev = ctx.previous?.get(normTeam(homeTeam));
  const aPrev = ctx.previous?.get(normTeam(awayTeam));

  // Rest, in days. The widest legitimate schedule signal in the sport: a
  // Sunday-to-Thursday turnaround against a post-bye fortnight is ~4 days
  // versus ~14.
  if (kickoffISO && hPrev?.when && aPrev?.when) {
    const t = new Date(kickoffISO).getTime();
    const hRest = (t - new Date(hPrev.when).getTime()) / 86400000;
    const aRest = (t - new Date(aPrev.when).getTime()) / 86400000;
    if (Number.isFinite(hRest) && Number.isFinite(aRest)) {
      f.nfl_rest_days_diff = clamp((hRest - aRest) / SCALE.restDays);
      // Explicit short-week and off-bye flags. The continuous version above
      // blurs them together, and both are known to behave non-linearly.
      f.nfl_short_week_diff = clamp(((aRest < 5.5 ? 1 : 0) - (hRest < 5.5 ? 1 : 0)));
      f.nfl_off_bye_diff = clamp(((hRest > 10 ? 1 : 0) - (aRest > 10 ? 1 : 0)));
    }
  }

  // Travel since the previous game, using that game's venue.
  if (hPrev?.venueTeam && aPrev?.venueTeam) {
    const hFrom = venueFor(hPrev.venueTeam);
    const aFrom = venueFor(aPrev.venueTeam);
    if (hFrom && aFrom) {
      const hMiles = haversineMiles(hFrom, venue);
      const aMiles = haversineMiles(aFrom, venue);
      if (hMiles !== null && aMiles !== null) {
        f.nfl_travel_miles_diff = clamp((aMiles - hMiles) / SCALE.distance);
      }
    }
  }

  return f;
}

function featureNames() {
  return [
    'nfl_tz_shift_diff',
    'nfl_rest_days_diff',
    'nfl_short_week_diff',
    'nfl_off_bye_diff',
    'nfl_travel_miles_diff',
  ];
}

module.exports = {
  fetchNflContext,
  fetchPreviousGames,
  buildNflFeatures,
  venueFor,
  featureNames,
  VENUES,
  SCALE,
  MAX_ABS,
};
