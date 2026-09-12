'use strict';
// =============================================================
// src/arena-context.js — schedule-density, travel and body-clock CANDIDATES
//                        for NBA and NHL (weight 0)
//
// 2026-09-12. Built now, DORMANT until each league's season opens. src/
// season-gate.js keeps these from firing a single HTTP call before then, and
// more importantly keeps an offseason query from returning last season's
// numbers dressed up as current. The work being done ahead of time is the whole
// point: a candidate declared the week a season starts has a full season of
// record, and one declared in December has lost a third of it.
//
// WHY SCHEDULE DENSITY IS THE RIGHT FIRST BATCH FOR THESE TWO SPORTS. NBA and
// NHL teams play 82 games in ~26 weeks, which produces back-to-backs, three
// games in four nights, and long multi-city road trips — none of which exist in
// baseball's series structure or football's weekly one. The fatigue effect of a
// second night in a row is among the better-documented results in either sport,
// and it is a schedule fact, knowable weeks ahead, which is exactly the kind of
// signal Nick's 9 PM window can actually use.
//
// The model already has homeDaysOff / awayDaysOff / B2B flags via
// scheduleInfo. These add what those cannot express: how far the team travelled
// to get here, how many time zones it crossed, and how crowded the last four
// nights were rather than just whether yesterday had a game.
//
// COORDINATES ARE TABLED because ESPN exposes arenas as city/state only, with
// no lat/long — the same limitation as NFL. Distances feed a 1500-mile scale,
// so city-centre precision is far finer than needed. Time zones are the part
// that must be exact, and those are a property of the city. Team display names
// were read from ESPN's own team endpoints on 2026-09-12 rather than guessed,
// which is how "Utah Mammoth" is spelled correctly here.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');
const { haversineMiles, tzOffsetHours } = require('./travel-context');

const MAX_ABS = 3;

const SCALE = {
  restDays: 2.0,    // 2 days of rest difference = 1 unit
  distance: 1500,
  tzShift: 2.0,
  density: 2.0,     // 2 extra games in the last 4 nights = 1 unit
};

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));

// [lat, lon, IANA zone]
const NBA_VENUES = {
  'Atlanta Hawks':           [33.7573, -84.3963,  'America/New_York'],
  'Boston Celtics':          [42.3662, -71.0621,  'America/New_York'],
  'Brooklyn Nets':           [40.6826, -73.9754,  'America/New_York'],
  'Charlotte Hornets':       [35.2251, -80.8392,  'America/New_York'],
  'Chicago Bulls':           [41.8807, -87.6742,  'America/Chicago'],
  'Cleveland Cavaliers':     [41.4965, -81.6882,  'America/New_York'],
  'Dallas Mavericks':        [32.7905, -96.8104,  'America/Chicago'],
  'Denver Nuggets':          [39.7487, -105.0077, 'America/Denver'],
  'Detroit Pistons':         [42.3410, -83.0552,  'America/New_York'],
  'Golden State Warriors':   [37.7680, -122.3877, 'America/Los_Angeles'],
  'Houston Rockets':         [29.7508, -95.3621,  'America/Chicago'],
  'Indiana Pacers':          [39.7640, -86.1555,  'America/Indiana/Indianapolis'],
  'LA Clippers':             [33.9450, -118.3417, 'America/Los_Angeles'],
  'Los Angeles Lakers':      [34.0430, -118.2673, 'America/Los_Angeles'],
  'Memphis Grizzlies':       [35.1382, -90.0506,  'America/Chicago'],
  'Miami Heat':              [25.7814, -80.1870,  'America/New_York'],
  'Milwaukee Bucks':         [43.0451, -87.9172,  'America/Chicago'],
  'Minnesota Timberwolves':  [44.9795, -93.2760,  'America/Chicago'],
  'New Orleans Pelicans':    [29.9490, -90.0821,  'America/Chicago'],
  'New York Knicks':         [40.7505, -73.9934,  'America/New_York'],
  'Oklahoma City Thunder':   [35.4634, -97.5151,  'America/Chicago'],
  'Orlando Magic':           [28.5392, -81.3839,  'America/New_York'],
  'Philadelphia 76ers':      [39.9012, -75.1720,  'America/New_York'],
  'Phoenix Suns':            [33.4457, -112.0712, 'America/Phoenix'],
  'Portland Trail Blazers':  [45.5316, -122.6668, 'America/Los_Angeles'],
  'Sacramento Kings':        [38.5802, -121.4997, 'America/Los_Angeles'],
  'San Antonio Spurs':       [29.4270, -98.4375,  'America/Chicago'],
  'Toronto Raptors':         [43.6435, -79.3791,  'America/Toronto'],
  'Utah Jazz':               [40.7683, -111.9011, 'America/Denver'],
  'Washington Wizards':      [38.8981, -77.0209,  'America/New_York'],
};

const NHL_VENUES = {
  'Anaheim Ducks':           [33.8078, -117.8766, 'America/Los_Angeles'],
  'Boston Bruins':           [42.3662, -71.0621,  'America/New_York'],
  'Buffalo Sabres':          [42.8750, -78.8764,  'America/New_York'],
  'Calgary Flames':          [51.0374, -114.0519, 'America/Edmonton'],
  'Carolina Hurricanes':     [35.8033, -78.7219,  'America/New_York'],
  'Chicago Blackhawks':      [41.8807, -87.6742,  'America/Chicago'],
  'Colorado Avalanche':      [39.7487, -105.0077, 'America/Denver'],
  'Columbus Blue Jackets':   [39.9694, -83.0060,  'America/New_York'],
  'Dallas Stars':            [32.7905, -96.8104,  'America/Chicago'],
  'Detroit Red Wings':       [42.3410, -83.0552,  'America/New_York'],
  'Edmonton Oilers':         [53.5469, -113.4973, 'America/Edmonton'],
  'Florida Panthers':        [26.1585, -80.3255,  'America/New_York'],
  'Los Angeles Kings':       [34.0430, -118.2673, 'America/Los_Angeles'],
  'Minnesota Wild':          [44.9447, -93.1010,  'America/Chicago'],
  'Montreal Canadiens':      [45.4961, -73.5693,  'America/Toronto'],
  'Nashville Predators':     [36.1593, -86.7785,  'America/Chicago'],
  'New Jersey Devils':       [40.7336, -74.1711,  'America/New_York'],
  'New York Islanders':      [40.7005, -73.7257,  'America/New_York'],
  'New York Rangers':        [40.7505, -73.9934,  'America/New_York'],
  'Ottawa Senators':         [45.2969, -75.9271,  'America/Toronto'],
  'Philadelphia Flyers':     [39.9012, -75.1720,  'America/New_York'],
  'Pittsburgh Penguins':     [40.4395, -79.9896,  'America/New_York'],
  'San Jose Sharks':         [37.3327, -121.9012, 'America/Los_Angeles'],
  'Seattle Kraken':          [47.6221, -122.3540, 'America/Los_Angeles'],
  'St. Louis Blues':         [38.6268, -90.2027,  'America/Chicago'],
  'Tampa Bay Lightning':     [27.9427, -82.4518,  'America/New_York'],
  'Toronto Maple Leafs':     [43.6435, -79.3791,  'America/Toronto'],
  'Utah Mammoth':            [40.7683, -111.9011, 'America/Denver'],
  'Vancouver Canucks':       [49.2778, -123.1088, 'America/Vancouver'],
  'Vegas Golden Knights':    [36.1029, -115.1785, 'America/Los_Angeles'],
  'Washington Capitals':     [38.8981, -77.0209,  'America/New_York'],
  'Winnipeg Jets':           [49.8927, -97.1435,  'America/Winnipeg'],
};

const LEAGUES = {
  NBA: { path: 'basketball/nba', prefix: 'nba', venues: NBA_VENUES },
  NHL: { path: 'hockey/nhl',     prefix: 'nhl', venues: NHL_VENUES },
};

// Keys normalised at load. normTeam strips digits and punctuation, so
// "Philadelphia 76ers" and "St. Louis Blues" must not be trusted as written —
// this is the bug that silently cost the 49ers every NFL travel feature.
const INDEX = {};
for (const [lg, cfg] of Object.entries(LEAGUES)) {
  INDEX[lg] = new Map(Object.entries(cfg.venues).map(([k, v]) => [normTeam(k), v]));
}

function venueFor(league, team) {
  const idx = INDEX[String(league || '').toUpperCase()];
  const v = idx && idx.get(normTeam(team));
  return v ? { lat: v[0], lon: v[1], tz: v[2] } : null;
}

/**
 * Every team's games in the window before `gameDate`, most recent first.
 *
 * Games ON the slate date are excluded: one of them is the game being
 * predicted, and using it as its own history would be circular.
 */
async function fetchRecentGames(league, gameDate, opts = {}) {
  const cfg = LEAGUES[String(league || '').toUpperCase()];
  if (!cfg) return new Map();
  const fetchFn = opts.fetch || globalThis.fetch;
  const lookbackDays = opts.lookbackDays ?? 7;
  const end = new Date(`${gameDate}T12:00:00Z`);
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/scoreboard`
    + `?dates=${fmt(start)}-${fmt(new Date(end.getTime() - 86400000))}&limit=500`;

  const out = new Map(); // normTeam -> [{ when, venueTeam }] newest first
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) return out;
    const json = await res.json();
    for (const ev of (json?.events || [])) {
      const when = ev?.date;
      if (!when || String(when).slice(0, 10) >= gameDate) continue;
      const comp = ev?.competitions?.[0];
      const homeComp = (comp?.competitors || []).find((x) => x.homeAway === 'home');
      for (const c of (comp?.competitors || [])) {
        const name = c?.team?.displayName;
        if (!name) continue;
        const key = normTeam(name);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push({ when, venueTeam: homeComp?.team?.displayName || null });
      }
    }
    for (const list of out.values()) list.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  } catch (err) {
    console.warn(`[arena-context] ${league} recent games fetch failed:`, err.message);
  }
  return out;
}

async function fetchArenaContext(league, gameDate, opts = {}) {
  const recent = await fetchRecentGames(league, gameDate, opts);
  return { league: String(league || '').toUpperCase(), gameDate, recent };
}

/**
 * Candidate features for one matchup. Positive favours home throughout.
 * Omitted, never zeroed, when inputs are unknown.
 */
function buildArenaFeatures(ctx, homeTeam, awayTeam, tipoffISO) {
  const f = {};
  if (!ctx || !ctx.league) return f;
  const cfg = LEAGUES[ctx.league];
  if (!cfg) return f;
  const p = cfg.prefix;

  const venue = venueFor(ctx.league, homeTeam);
  const awayHome = venueFor(ctx.league, awayTeam);
  if (!venue) return f;

  if (awayHome) {
    const vOff = tzOffsetHours(venue.tz, ctx.gameDate);
    const aOff = tzOffsetHours(awayHome.tz, ctx.gameDate);
    if (vOff !== null && aOff !== null) {
      // Positive = away travelled east into a later body time, the hard way.
      f[`${p}_tz_shift_diff`] = clamp((vOff - aOff) / SCALE.tzShift);
    }
  }

  const hList = ctx.recent?.get(normTeam(homeTeam)) || [];
  const aList = ctx.recent?.get(normTeam(awayTeam)) || [];
  const hPrev = hList[0], aPrev = aList[0];

  if (tipoffISO && hPrev?.when && aPrev?.when) {
    const t = new Date(tipoffISO).getTime();
    const hRest = (t - new Date(hPrev.when).getTime()) / 86400000;
    const aRest = (t - new Date(aPrev.when).getTime()) / 86400000;
    if (Number.isFinite(hRest) && Number.isFinite(aRest)) {
      f[`${p}_rest_days_diff`] = clamp((hRest - aRest) / SCALE.restDays);
      // Back-to-back: played yesterday. The single best-documented fatigue
      // effect in both sports, and a binary the continuous version blurs.
      const b2b = (r) => (r < 1.5 ? 1 : 0);
      f[`${p}_b2b_diff`] = clamp(b2b(aRest) - b2b(hRest));
      // Density: games in the four nights before this one. A third game in
      // four nights is a different animal from a single back-to-back.
      const within = (list) => list.filter(
        (g) => (t - new Date(g.when).getTime()) / 86400000 <= 4).length;
      f[`${p}_density_diff`] = clamp((within(aList) - within(hList)) / SCALE.density);
    }
  }

  if (hPrev?.venueTeam && aPrev?.venueTeam) {
    const hFrom = venueFor(ctx.league, hPrev.venueTeam);
    const aFrom = venueFor(ctx.league, aPrev.venueTeam);
    if (hFrom && aFrom) {
      const hMiles = haversineMiles(hFrom, venue);
      const aMiles = haversineMiles(aFrom, venue);
      if (hMiles !== null && aMiles !== null) {
        f[`${p}_travel_miles_diff`] = clamp((aMiles - hMiles) / SCALE.distance);
      }
    }
  }

  return f;
}

function featureNames(league) {
  const cfg = LEAGUES[String(league || '').toUpperCase()];
  if (!cfg) return [];
  const p = cfg.prefix;
  return [
    `${p}_tz_shift_diff`,
    `${p}_rest_days_diff`,
    `${p}_b2b_diff`,
    `${p}_density_diff`,
    `${p}_travel_miles_diff`,
  ];
}

module.exports = {
  fetchArenaContext,
  fetchRecentGames,
  buildArenaFeatures,
  venueFor,
  featureNames,
  NBA_VENUES,
  NHL_VENUES,
  LEAGUES,
  SCALE,
  MAX_ABS,
};
