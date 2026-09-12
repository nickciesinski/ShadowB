'use strict';
// =============================================================
// src/mlb-matchup.js — starting-pitcher and platoon CANDIDATES (MLB)
//
// 2026-09-11. All weight 0: nothing here moves a pick or stakes a dollar. See
// src/bullpen-fatigue.js for the pattern and src/form-windows.js for the
// reasoning about why less-priced beats more-numerous.
//
// WHAT THIS ADDS BEYOND THE EXISTING PITCHER FEATURES. The model already uses
// starter ERA (via computePitcherAdj -> starterAdj) and season WHIP. Both are
// season-long and thoroughly priced. These are the same pitcher measured on
// axes the closing line reacts to more slowly:
//
//   - days of rest, and pitch count in his LAST start (fatigue, short rest)
//   - his last three starts rather than his season (recent form)
//   - the PLATOON matchup: how well each lineup actually hits the hand the
//     opposing starter throws with
//
// The platoon one is the most interesting of the batch. Handedness is public
// and the market certainly knows it, but "this lineup is 90 points of OPS worse
// against lefties" is a second-order fact that tends to be priced roughly, as a
// generic adjustment, rather than per-team.
//
// ALL PRE-GAME. Probable pitchers are published the day before (verified
// 2026-09-11: 28 of 30 present for the next day's slate). Game logs and splits
// cover completed games only. Nothing here needs information that appears after
// first pitch, which is the rule every feature must satisfy — see CLAUDE.md.
//
// COST. One call for probables, one for handedness, two for splits, and one
// game log per probable starter (~30). StatsAPI is free and unkeyed.
// =============================================================

const { normTeam } = require('./bullpen-fatigue');
const { ptDaysAgo } = require('./form-windows');

const API = 'https://statsapi.mlb.com/api/v1';

// Clamp, as everywhere else: a plausible value is inside +/-3 and anything
// beyond it is upstream corruption rather than a real edge.
const MAX_ABS = 3;

// Unit scales, chosen to sit alongside the season-long weights already in
// config/model-params.MLB.json.
const SCALE = {
  rest: 2.0,        // 2 days of extra rest = 1 unit
  lastPitches: 20,  // 20 pitches = 1 unit
  k9: 1.5,
  bb9: 1.0,
  ip: 1.0,          // 1 inning per start = 1 unit
  ops: 0.10,        // matches ops_diff
};

const clamp = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function getJson(url, fetchFn) {
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Probable starters for a slate, keyed "awayTeam@homeTeam" (normalised).
 * Returns { [key]: { home: {id,name}, away: {id,name} } }.
 */
async function fetchProbables(gameDate, fetchFn = globalThis.fetch) {
  const json = await getJson(
    `${API}/schedule?sportId=1&date=${gameDate}&hydrate=probablePitcher(person)`, fetchFn);
  const out = {};
  for (const g of (json?.dates?.[0]?.games || [])) {
    const home = g?.teams?.home, away = g?.teams?.away;
    if (!home?.team?.name || !away?.team?.name) continue;
    const key = `${normTeam(away.team.name)}@${normTeam(home.team.name)}`;
    out[key] = {
      home: home.probablePitcher
        ? { id: home.probablePitcher.id, name: home.probablePitcher.fullName } : null,
      away: away.probablePitcher
        ? { id: away.probablePitcher.id, name: away.probablePitcher.fullName } : null,
    };
  }
  return out;
}

/** Throwing hand ('L'/'R') for many pitchers in one call. */
async function fetchHandedness(ids, fetchFn = globalThis.fetch) {
  const out = new Map();
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return out;
  const json = await getJson(`${API}/people?personIds=${unique.join(',')}`, fetchFn);
  for (const p of (json?.people || [])) {
    const code = p?.pitchHand?.code;
    if (p?.id && (code === 'L' || code === 'R')) out.set(p.id, code);
  }
  return out;
}

/**
 * A starter's recent work: rest since last start, that start's pitch count, and
 * his last three starts in aggregate.
 *
 * `beforeDate` excludes anything on or after the game date, so a game already
 * under way can never leak in.
 */
async function fetchStarterForm(id, season, beforeDate, fetchFn = globalThis.fetch) {
  const json = await getJson(
    `${API}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}`, fetchFn);
  const splits = (json?.stats?.[0]?.splits || [])
    .filter((s) => s.date && s.date < beforeDate)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!splits.length) return null;

  const last = splits[splits.length - 1];
  const daysRest = Math.round(
    (new Date(`${beforeDate}T12:00:00Z`) - new Date(`${last.date}T12:00:00Z`)) / 86400000);

  const recent = splits.slice(-3);
  let k = 0, bb = 0, ip = 0;
  for (const s of recent) {
    k += num(s.stat.strikeOuts) || 0;
    bb += num(s.stat.baseOnBalls) || 0;
    ip += num(s.stat.inningsPitched) || 0;
  }
  return {
    daysRest,
    lastPitches: num(last.stat.numberOfPitches),
    k9: ip > 0 ? (k * 9) / ip : null,
    bb9: ip > 0 ? (bb * 9) / ip : null,
    ipPerStart: recent.length ? ip / recent.length : null,
    starts: recent.length,
  };
}

/** Team OPS against left- and right-handed pitching. */
async function fetchPlatoonSplits(season, fetchFn = globalThis.fetch) {
  const out = new Map(); // normTeam -> { L: ops, R: ops }
  for (const [code, hand] of [['vl', 'L'], ['vr', 'R']]) {
    const json = await getJson(
      `${API}/teams/stats?season=${season}&group=hitting&stats=statSplits`
      + `&sitCodes=${code}&sportId=1&gameType=R`, fetchFn);
    for (const s of (json?.stats?.[0]?.splits || [])) {
      const name = s?.team?.name;
      const ops = num(s?.stat?.ops);
      if (!name || ops === null) continue;
      const key = normTeam(name);
      const prev = out.get(key) || {};
      prev[hand] = ops;
      out.set(key, prev);
    }
  }
  return out;
}

/**
 * Everything the features need, for a whole slate. One object, fetched once.
 *
 * Any individual failure leaves that piece absent, and the features that depend
 * on it are simply omitted — never defaulted to 0, which would assert equality
 * between two teams we know nothing about.
 */
async function fetchMatchupContext(gameDate, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const season = gameDate.slice(0, 4);
  const probables = await fetchProbables(gameDate, fetchFn);

  const ids = [];
  for (const v of Object.values(probables)) {
    if (v.home?.id) ids.push(v.home.id);
    if (v.away?.id) ids.push(v.away.id);
  }

  const [hands, platoon] = await Promise.all([
    fetchHandedness(ids, fetchFn),
    fetchPlatoonSplits(season, fetchFn),
  ]);

  // One game log per starter. Sequential in small batches so a 30-game slate
  // does not open 60 sockets at once.
  const starters = new Map();
  const BATCH = 6;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const forms = await Promise.all(
      chunk.map((id) => fetchStarterForm(id, season, gameDate, fetchFn)));
    chunk.forEach((id, j) => { if (forms[j]) starters.set(id, forms[j]); });
  }

  return { gameDate, probables, hands, platoon, starters };
}

/**
 * Candidate features for one matchup. Positive favours home throughout.
 *
 * A feature is omitted when either side is unknown rather than zeroed: absence
 * is the truth, and the candidate machinery records it as unmeasured.
 */
function buildMatchupFeatures(ctx, homeTeam, awayTeam) {
  const f = {};
  if (!ctx) return f;
  const key = `${normTeam(awayTeam)}@${normTeam(homeTeam)}`;
  const pr = ctx.probables?.[key];
  const hs = pr?.home?.id != null ? ctx.starters?.get(pr.home.id) : null;
  const as = pr?.away?.id != null ? ctx.starters?.get(pr.away.id) : null;

  if (hs && as) {
    if (hs.daysRest != null && as.daysRest != null) {
      f.starter_rest_diff = clamp((hs.daysRest - as.daysRest) / SCALE.rest);
    }
    if (hs.lastPitches != null && as.lastPitches != null) {
      // More pitches last time out is worse, so away-minus-home.
      f.starter_last_pitches_diff = clamp((as.lastPitches - hs.lastPitches) / SCALE.lastPitches);
    }
    if (hs.k9 != null && as.k9 != null) {
      f.starter_k9_l3_diff = clamp((hs.k9 - as.k9) / SCALE.k9);
    }
    if (hs.bb9 != null && as.bb9 != null) {
      // Walks are bad: inverted.
      f.starter_bb9_l3_diff = clamp((as.bb9 - hs.bb9) / SCALE.bb9);
    }
    if (hs.ipPerStart != null && as.ipPerStart != null) {
      f.starter_ip_l3_diff = clamp((hs.ipPerStart - as.ipPerStart) / SCALE.ip);
    }
  }

  // Platoon: each lineup against the hand it will actually face.
  const homeHand = pr?.home?.id != null ? ctx.hands?.get(pr.home.id) : null;
  const awayHand = pr?.away?.id != null ? ctx.hands?.get(pr.away.id) : null;
  const homeBats = ctx.platoon?.get(normTeam(homeTeam));
  const awayBats = ctx.platoon?.get(normTeam(awayTeam));
  if (homeHand && awayHand && homeBats && awayBats) {
    const homeVs = homeBats[awayHand];   // home lineup vs the away starter's hand
    const awayVs = awayBats[homeHand];
    if (homeVs != null && awayVs != null) {
      f.platoon_ops_diff = clamp((homeVs - awayVs) / SCALE.ops);
    }
  }

  return f;
}

/** Every feature name this module can emit. */
function featureNames() {
  return [
    'starter_rest_diff',
    'starter_last_pitches_diff',
    'starter_k9_l3_diff',
    'starter_bb9_l3_diff',
    'starter_ip_l3_diff',
    'platoon_ops_diff',
  ];
}

module.exports = {
  fetchMatchupContext,
  fetchProbables,
  fetchHandedness,
  fetchStarterForm,
  fetchPlatoonSplits,
  buildMatchupFeatures,
  featureNames,
  SCALE,
  MAX_ABS,
};
