// One canonical team-name normalizer + identity-key helpers, used by ingest,
// pick logging, grading, and (eventually) ESPN matching. Replaces the several
// ad-hoc normalizers scattered across the codebase.
const crypto = require('crypto');

// lowercase, strip diacritics (Montréal → montreal), collapse punctuation to spaces.
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

// game_key: prefer the Odds API event id (exact, doubleheader-safe). Fall back to a
// stable natural hash for rows with no event id (historical / ESPN-only games).
// side/pick_date are deliberately NOT in the key — that's what enforces no-chasing
// and no-daily-re-picking structurally.
function gameKey(eventId, league, away, home, gameDate, gameNumber) {
  if (eventId) return `evt:${eventId}`;
  return 'nat:' + sha1(`${(league || '').toLowerCase()}|${norm(away)}@${norm(home)}|${gameDate || ''}|${gameNumber || 1}`);
}

function pickId(gk, market) {
  return `${gk}:${String(market || '').toLowerCase()}`;
}

// Season label, e.g. 'NFL-2026'. Cross-year leagues are labeled by their start year.
// This is DATA (not identity), so an approximation is fine for now; §12 refines it
// off config/season-windows.json.
function seasonOf(league, gameDate) {
  if (!gameDate) return null;
  const [y, m] = String(gameDate).split('-').map(Number);
  if (!y || !m) return null;
  const startMonth = { NFL: 8, NBA: 9, NHL: 9, EPL: 7, MLB: 1 }[league] || 1;
  const seasonYear = m >= startMonth ? y : (league === 'MLB' ? y : y - 1);
  return `${league}-${seasonYear}`;
}

// The calendar date a game "belongs to" in its own league's local time.
//
// 2026-08-02: game_date was previously `commence_time.slice(0,10)` — the UTC
// date. A 7:10pm ET first pitch is 23:10 UTC, but a 9:10pm ET one is 01:10 UTC
// the NEXT day, so roughly half of every evening slate was stamped with
// tomorrow's date. That silently (a) put finished games on the following day's
// card, (b) split one night's slate across two game_date groups, and (c) made
// the ESPN grader fetch the wrong scoreboard. US leagues date their games by
// Eastern time regardless of venue; EPL by London time.
const LEAGUE_TZ = {
  MLB: 'America/New_York', NBA: 'America/New_York',
  NHL: 'America/New_York', NFL: 'America/New_York',
  EPL: 'Europe/London',
};

function localGameDate(league, commenceIso) {
  if (!commenceIso) return null;
  const d = new Date(commenceIso);
  if (isNaN(d.getTime())) return null;
  const tz = LEAGUE_TZ[league] || 'America/New_York';
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    // If the runtime lacks full ICU, fall back to the old UTC behavior rather
    // than writing null — a slightly wrong date beats no date.
    return String(commenceIso).slice(0, 10);
  }
}

module.exports = { norm, sha1, gameKey, pickId, seasonOf, localGameDate, LEAGUE_TZ };
