'use strict';
// 2026-09-12 — NBA/NHL schedule-density, travel and body-clock CANDIDATES.
//
// Built now, dormant until each season opens. The headline test is
// `every real ESPN team name resolves to an arena` — normTeam strips digits and
// punctuation, so "Philadelphia 76ers" and "St. Louis Blues" are exactly the
// shapes that silently cost the 49ers every NFL travel feature. Names were read
// from ESPN's own endpoints rather than guessed, which is also how
// "Utah Mammoth" is spelled correctly.
const test = require('node:test');
const assert = require('node:assert');
const ac = require('../src/arena-context');
const { normTeam } = require('../src/bullpen-fatigue');
const { isInSeason } = require('../src/season-windows');

const NBA = ['Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls',
  'Cleveland Cavaliers','Dallas Mavericks','Denver Nuggets','Detroit Pistons','Golden State Warriors',
  'Houston Rockets','Indiana Pacers','LA Clippers','Los Angeles Lakers','Memphis Grizzlies','Miami Heat',
  'Milwaukee Bucks','Minnesota Timberwolves','New Orleans Pelicans','New York Knicks',
  'Oklahoma City Thunder','Orlando Magic','Philadelphia 76ers','Phoenix Suns','Portland Trail Blazers',
  'Sacramento Kings','San Antonio Spurs','Toronto Raptors','Utah Jazz','Washington Wizards'];
const NHL = ['Anaheim Ducks','Boston Bruins','Buffalo Sabres','Calgary Flames','Carolina Hurricanes',
  'Chicago Blackhawks','Colorado Avalanche','Columbus Blue Jackets','Dallas Stars','Detroit Red Wings',
  'Edmonton Oilers','Florida Panthers','Los Angeles Kings','Minnesota Wild','Montreal Canadiens',
  'Nashville Predators','New Jersey Devils','New York Islanders','New York Rangers','Ottawa Senators',
  'Philadelphia Flyers','Pittsburgh Penguins','San Jose Sharks','Seattle Kraken','St. Louis Blues',
  'Tampa Bay Lightning','Toronto Maple Leafs','Utah Mammoth','Vancouver Canucks','Vegas Golden Knights',
  'Washington Capitals','Winnipeg Jets'];

test('every real ESPN team name resolves to an arena', () => {
  assert.deepStrictEqual(NBA.filter((n) => !ac.venueFor('NBA', n)), []);
  assert.deepStrictEqual(NHL.filter((n) => !ac.venueFor('NHL', n)), []);
  assert.strictEqual(NBA.length, 30);
  assert.strictEqual(NHL.length, 32);
});

test('the digit and punctuation traps specifically', () => {
  assert.ok(ac.venueFor('NBA', 'Philadelphia 76ers'), 'digits are stripped by normTeam');
  assert.ok(ac.venueFor('NHL', 'St. Louis Blues'), 'the period is stripped too');
  assert.strictEqual(normTeam('Philadelphia 76ers'), 'philadelphiaers');
});

test('Canadian and non-DST zones are right', () => {
  const { tzOffsetHours } = require('../src/travel-context');
  assert.strictEqual(ac.venueFor('NHL', 'Winnipeg Jets').tz, 'America/Winnipeg');
  assert.strictEqual(ac.venueFor('NHL', 'Calgary Flames').tz, 'America/Edmonton');
  assert.strictEqual(ac.venueFor('NHL', 'Vancouver Canucks').tz, 'America/Vancouver');
  // Phoenix never observes DST; Indiana does.
  assert.strictEqual(tzOffsetHours(ac.venueFor('NBA', 'Phoenix Suns').tz, '2026-12-01'), -7);
  assert.strictEqual(tzOffsetHours(ac.venueFor('NBA', 'Phoenix Suns').tz, '2026-07-01'), -7);
  assert.strictEqual(tzOffsetHours(ac.venueFor('NBA', 'Indiana Pacers').tz, '2026-12-01'), -5);
});

test('teams sharing a city are not accidentally merged', () => {
  const knicks = ac.venueFor('NBA', 'New York Knicks');
  const nets = ac.venueFor('NBA', 'Brooklyn Nets');
  assert.notDeepStrictEqual(knicks, nets, 'MSG and Barclays are different buildings');
});

const ctxOf = (league, recent) => ({ league, gameDate: '2027-01-15', recent: new Map(Object.entries(recent)) });

test('a back-to-back counts against the team that played yesterday', () => {
  const f = ac.buildArenaFeatures(ctxOf('NBA', {
    [normTeam('Boston Celtics')]: [{ when: '2027-01-12T00:00:00Z', venueTeam: 'Boston Celtics' }],
    [normTeam('Miami Heat')]:     [{ when: '2027-01-14T23:00:00Z', venueTeam: 'Miami Heat' }],
  }), 'Boston Celtics', 'Miami Heat', '2027-01-15T23:00:00Z');
  assert.strictEqual(f.nba_b2b_diff, 1, 'away on a back-to-back favours home');
  assert.ok(f.nba_rest_days_diff > 0);
});

test('density counts games in the last four nights, not just yesterday', () => {
  const f = ac.buildArenaFeatures(ctxOf('NBA', {
    [normTeam('Boston Celtics')]: [{ when: '2027-01-13T00:00:00Z', venueTeam: 'Boston Celtics' }],
    [normTeam('Miami Heat')]: [
      { when: '2027-01-13T00:00:00Z', venueTeam: 'Miami Heat' },
      { when: '2027-01-12T00:00:00Z', venueTeam: 'Miami Heat' },
      { when: '2027-01-11T23:00:00Z', venueTeam: 'Miami Heat' },
    ],
  }), 'Boston Celtics', 'Miami Heat', '2027-01-15T00:00:00Z');
  assert.ok(f.nba_density_diff > 0, 'away played three of the last four nights');
});

test('eastward travel favours the home team, NHL too', () => {
  const f = ac.buildArenaFeatures(ctxOf('NHL', {}), 'Boston Bruins', 'Vancouver Canucks');
  assert.ok(f.nhl_tz_shift_diff > 0);
  const back = ac.buildArenaFeatures(ctxOf('NHL', {}), 'Vancouver Canucks', 'Boston Bruins');
  assert.ok(back.nhl_tz_shift_diff < 0);
});

test('features carry the right league prefix', () => {
  const nba = ac.buildArenaFeatures(ctxOf('NBA', {}), 'Boston Celtics', 'Los Angeles Lakers');
  const nhl = ac.buildArenaFeatures(ctxOf('NHL', {}), 'Boston Bruins', 'Los Angeles Kings');
  assert.ok('nba_tz_shift_diff' in nba && !('nhl_tz_shift_diff' in nba));
  assert.ok('nhl_tz_shift_diff' in nhl && !('nba_tz_shift_diff' in nhl));
});

test('games on the slate date are never used as their own history', () => {
  // A game being predicted cannot be its own previous game.
  const ctx = ctxOf('NBA', {});
  assert.deepStrictEqual(ac.buildArenaFeatures(ctx, 'Not A Team', 'Miami Heat'), {});
});

test('missing inputs omit features rather than claiming full rest', () => {
  const f = ac.buildArenaFeatures(ctxOf('NBA', {}), 'Boston Celtics', 'Miami Heat');
  assert.ok(!('nba_rest_days_diff' in f));
  assert.ok(!('nba_travel_miles_diff' in f));
  assert.deepStrictEqual(ac.buildArenaFeatures(null, 'a', 'b'), {});
  assert.deepStrictEqual(ac.buildArenaFeatures(ctxOf('XFL', {}), 'a', 'b'), {});
});

test('these stay dormant until their seasons open', () => {
  // The whole point of building them now: no calls, and no stale offseason
  // data, until the league is actually playing. Gating reuses the existing
  // src/season-windows.js, which takes a Date.
  const d = (y, m, day) => new Date(y, m - 1, day);
  assert.strictEqual(isInSeason('NBA', d(2026, 9, 12)), false);
  assert.strictEqual(isInSeason('NHL', d(2026, 9, 12)), false);
  assert.strictEqual(isInSeason('NBA', d(2026, 10, 20)), true);
  assert.strictEqual(isInSeason('NHL', d(2026, 10, 8)), true);
});

test('every feature is declared at weight 0 in both shipped configs', () => {
  for (const lg of ['NBA', 'NHL']) {
    const cfg = require(`../config/model-params.${lg}.json`);
    const names = ac.featureNames(lg);
    for (const [market, w] of Object.entries(cfg)) {
      if (!w || typeof w !== 'object' || !(names[0] in w)) continue;
      for (const n of names) assert.strictEqual(w[n], 0, `${lg} ${market}.${n}`);
    }
  }
});
