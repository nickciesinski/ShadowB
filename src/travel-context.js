'use strict';
// =============================================================
// src/travel-context.js — travel, body clock and rest CANDIDATES (MLB)
//
// 2026-09-11. All weight 0: nothing here moves a pick. See CLAUDE.md for the
// rule every candidate must satisfy (verifiable before 9 PM PT, never derived
// from anything published after first pitch).
//
// WHY. The model already has homeDaysOff / awayDaysOff / back-to-back flags,
// which are the coarse version of this. What it does not have is WHERE a team
// is coming from. Those are different quantities: three days off after flying
// Seattle -> Miami is not three days off after a bus ride across town.
//
// Three signals, in rough order of how well the literature supports them:
//
//   1. BODY-CLOCK SHIFT. Hours between the team's home time zone and the venue
//      time zone, signed by direction. Eastward travel is the harder one — you
//      lose hours and play at what your body calls late. This is the most
//      robust of the three and the market prices it loosely at best.
//   2. TRAVEL DISTANCE from the team's PREVIOUS GAME, not from its home park.
//      Mid-road-trip, home-park distance is simply wrong: a team on day four in
//      Chicago has not just flown from Seattle. Using the previous venue is the
//      whole reason this module fetches a schedule window.
//   3. TRUE REST, in hours between the previous game's start and this one.
//      Whole days are a lossy rounding of that: a getaway day game after a
//      night game is ~17 hours, and a plain day off is ~45.
//
// All of it derives from completed games plus a published schedule, so there is
// nothing here that is not knowable the night before.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');

const API = 'https://statsapi.mlb.com/api/v1';
const MAX_ABS = 3;

const SCALE = {
  tzShift: 2.0,    // 2 hours of body-clock shift = 1 unit
  distance: 1500,  // 1500 miles = 1 unit
  restHours: 24,   // one day = 1 unit
};

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));

/** Great-circle miles. */
function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * UTC offset in hours for an IANA zone on a given date.
 *
 * Computed rather than tabled because it has to be DST-correct: the same venue
 * is -7 in September and -8 in November, and a hard-coded table would quietly
 * mis-state every game after the changeover.
 */
function tzOffsetHours(timeZone, whenISO) {
  try {
    const d = new Date(`${whenISO}T18:00:00Z`);
    const tz = new Intl.DateTimeFormat('en-US', {
      timeZone, timeZoneName: 'shortOffset',
    }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
    const m = tz.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    return parseInt(m[1], 10) + (m[2] ? Math.sign(parseInt(m[1], 10)) * (parseInt(m[2], 10) / 60) : 0);
  } catch (err) {
    return null;
  }
}

async function getJson(url, fetchFn) {
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/** Each team's home venue coordinates and time zone. */
async function fetchHomeVenues(fetchFn = globalThis.fetch) {
  const json = await getJson(`${API}/teams?sportId=1&hydrate=venue(location,timezone)`, fetchFn);
  const out = new Map();
  for (const t of (json?.teams || [])) {
    const c = t?.venue?.location?.defaultCoordinates;
    if (!t?.name || !c) continue;
    out.set(normTeam(t.name), {
      lat: c.latitude, lon: c.longitude,
      tz: t.venue?.timeZone?.id || null,
      venue: t.venue?.name || null,
    });
  }
  return out;
}

/**
 * Each team's most recent game BEFORE `gameDate`: where it was, and when.
 *
 * Looks back `lookbackDays` so a team with an off day is still found.
 */
async function fetchPreviousGames(gameDate, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const lookbackDays = opts.lookbackDays ?? 5;
  const start = new Date(`${gameDate}T12:00:00Z`);
  const startDate = new Date(start.getTime() - lookbackDays * 86400000)
    .toISOString().slice(0, 10);
  // endDate is the day BEFORE the slate: a game on the slate date is the one
  // being predicted, and using it as its own "previous game" would be circular.
  const endDate = new Date(start.getTime() - 86400000).toISOString().slice(0, 10);

  const json = await getJson(
    `${API}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=venue(location)`,
    fetchFn);

  const out = new Map(); // normTeam -> { lat, lon, when, date }
  for (const day of (json?.dates || [])) {
    for (const g of (day.games || [])) {
      const c = g?.venue?.location?.defaultCoordinates;
      if (!c) continue;
      const when = g.gameDate;
      for (const side of ['home', 'away']) {
        const name = g?.teams?.[side]?.team?.name;
        if (!name) continue;
        const key = normTeam(name);
        const prev = out.get(key);
        // Keep the LATEST game before the slate date.
        if (!prev || String(when) > String(prev.when)) {
          out.set(key, { lat: c.latitude, lon: c.longitude, when, date: g.officialDate || day.date });
        }
      }
    }
  }
  return out;
}

/** Everything the features need for one slate. */
async function fetchTravelContext(gameDate, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const [homes, previous] = await Promise.all([
    fetchHomeVenues(fetchFn),
    fetchPreviousGames(gameDate, { ...opts, fetch: fetchFn }),
  ]);
  return { gameDate, homes, previous };
}

/**
 * Candidate features for one matchup. Positive favours home throughout.
 *
 * Each feature is omitted when its inputs are unknown, never zeroed — 0 would
 * assert "no travel, no shift, equal rest", which is a claim about two teams we
 * know nothing about.
 */
function buildTravelFeatures(ctx, homeTeam, awayTeam, commenceTime) {
  const f = {};
  if (!ctx) return f;
  const hk = normTeam(homeTeam), ak = normTeam(awayTeam);
  const venue = ctx.homes?.get(hk);           // the game is at the home team's park
  const awayHome = ctx.homes?.get(ak);
  if (!venue) return f;

  // 1. Body-clock shift for the away team: venue offset minus its home offset.
  //    POSITIVE means the venue is ahead of the away team's home zone, i.e. the
  //    away team has travelled EAST and is playing at what its body calls late.
  //    That is the harder direction, so it is already good for home and needs
  //    no flip. (An earlier version negated this and reported a jet-lagged away
  //    team as an advantage to that team — exactly backwards.)
  //    Seattle at the Yankees: venue -4, home -7, so +3 hours -> +1.5.
  if (awayHome?.tz && venue.tz) {
    const vOff = tzOffsetHours(venue.tz, ctx.gameDate);
    const aOff = tzOffsetHours(awayHome.tz, ctx.gameDate);
    if (vOff !== null && aOff !== null) {
      f.away_tz_shift_diff = clamp((vOff - aOff) / SCALE.tzShift);
    }
  }

  // 2. Distance each team travelled since its previous game.
  const hPrev = ctx.previous?.get(hk);
  const aPrev = ctx.previous?.get(ak);
  const hMiles = hPrev ? haversineMiles({ lat: hPrev.lat, lon: hPrev.lon }, venue) : null;
  const aMiles = aPrev ? haversineMiles({ lat: aPrev.lat, lon: aPrev.lon }, venue) : null;
  if (hMiles !== null && aMiles !== null) {
    // More travel is worse, so away-minus-home keeps positive favouring home.
    f.travel_miles_diff = clamp((aMiles - hMiles) / SCALE.distance);
  }

  // 3. True rest, in hours, from each team's previous first pitch to this one.
  if (commenceTime && hPrev?.when && aPrev?.when) {
    const t = new Date(commenceTime).getTime();
    const hRest = (t - new Date(hPrev.when).getTime()) / 3600000;
    const aRest = (t - new Date(aPrev.when).getTime()) / 3600000;
    if (Number.isFinite(hRest) && Number.isFinite(aRest)) {
      f.rest_hours_diff = clamp((hRest - aRest) / SCALE.restHours);
    }
  }

  return f;
}

function featureNames() {
  return ['away_tz_shift_diff', 'travel_miles_diff', 'rest_hours_diff'];
}

module.exports = {
  fetchTravelContext,
  fetchHomeVenues,
  fetchPreviousGames,
  buildTravelFeatures,
  haversineMiles,
  tzOffsetHours,
  featureNames,
  SCALE,
  MAX_ABS,
};
