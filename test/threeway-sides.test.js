'use strict';
// 2026-08-28: pins 3-way (soccer) side selection in the web app.
//
// The bug this guards: a soccer moneyline has three outcomes but the model logs
// ONE pick per match, so putting yourself on another side used to run through
// flipPick() — a two-way helper that swaps home/away and inverts the odds sign.
// It could not express a draw at all, and the inverted price was fiction.
//
// web/app/page.js is a JSX client component, so we can't require() it. These
// helpers are all plain top-level functions with no JSX in their bodies, so we
// slice them out by name and eval them. If someone renames or reshapes one, the
// extractor throws loudly rather than silently testing nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'page.js'), 'utf8');

// Pull `function name(...) { ... }` from column 0 up to the closing brace at column 0.
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `page.js no longer defines ${name}() — update this test`);
  const end = SRC.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `could not find the end of ${name}()`);
  return SRC.slice(start, end + 3);
}
function extractConst(decl) {
  const start = SRC.indexOf(decl);
  assert.notStrictEqual(start, -1, `page.js no longer defines \`${decl}\` — update this test`);
  const end = SRC.indexOf('\n', start);
  return SRC.slice(start, end + 1);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  extractConst("const SOCCER_LEAGUES = new Set("),
  extractConst("const isSoccer = (league) =>"),
  extractConst("const SIDES = ["),
  extractConst("const entryState = (v) =>"),
  extractConst("const entrySide = (v) =>"),
  extractConst("const isDrawPick = (d) =>"),
  extractFn('isThreeWay'),
  extractFn('modelSide'),
  extractFn('sideLabel'),
  extractFn('sidePrice'),
  extractFn('sideAvailable'),
  extractFn('pickForSide'),
  extractFn('displayPickFor'),
  extractFn('findOppositePick'),
  extractFn('flipPick'),
  extractFn('getPickStatus'),
  // `const` declarations stay lexical inside the vm script and never land on the
  // context object, unlike function declarations. Hand the arrow-function helpers
  // out explicitly so the assertions below can reach them.
  'globalThis.isDrawPick = isDrawPick; globalThis.entryState = entryState; globalThis.entrySide = entrySide; globalThis.isSoccer = isSoccer;',
].join('\n\n'), sandbox);

const {
  isThreeWay, modelSide, sidePrice, sideAvailable, pickForSide,
  displayPickFor, flipPick, getPickStatus, isDrawPick,
} = sandbox;

// A soccer moneyline row as it arrives from /api/data: model took the home side.
const epl = {
  league: 'EPL', betType: 'moneyline', market: 'moneyline',
  away: 'Arsenal', home: 'Chelsea', pick: 'Chelsea', selection: 'home',
  odds: -150, line: '', units: 0.4,
  altPrices: { home: -150, draw: 240, away: 310 },
};
const nba = {
  league: 'NBA', betType: 'moneyline', market: 'moneyline',
  away: 'Boston Celtics', home: 'Miami Heat', pick: 'Miami Heat',
  odds: -150, line: '', units: 0.4,
};

test('only soccer moneylines are treated as 3-way', () => {
  assert.strictEqual(isThreeWay(epl), true);
  assert.strictEqual(isThreeWay(nba), false, 'US moneylines stay two-way');
  assert.strictEqual(isThreeWay({ ...epl, betType: 'total' }), false);
  assert.strictEqual(isThreeWay({ ...epl, betType: 'spread' }), false, 'Asian handicap is two-way');
  assert.strictEqual(isThreeWay({ ...epl, league: 'LALIGA' }), true, 'other soccer leagues too');
});

test('modelSide reads the selection column, and falls back for legacy rows', () => {
  assert.strictEqual(modelSide(epl), 'home');
  assert.strictEqual(modelSide({ ...epl, selection: 'draw', pick: 'Draw' }), 'draw');
  // Legacy rows (written before the selection column) carry only the pick text.
  assert.strictEqual(modelSide({ ...epl, selection: '', pick: 'Chelsea' }), 'home');
  assert.strictEqual(modelSide({ ...epl, selection: '', pick: 'Arsenal' }), 'away');
  assert.strictEqual(modelSide({ ...epl, selection: '', pick: 'Draw' }), 'draw');
});

test('switching side uses the REAL price, never a flipped sign', () => {
  const drawn = pickForSide(epl, 'draw');
  assert.strictEqual(drawn.pick, 'Draw');
  assert.strictEqual(drawn.odds, 240, 'the actual draw price from the ledger');

  const away = pickForSide(epl, 'away');
  assert.strictEqual(away.pick, 'Arsenal');
  assert.strictEqual(away.odds, 310);

  // This is the old behaviour we are replacing — it never produced +310.
  assert.strictEqual(flipPick(epl).odds, 150, 'old two-way flip invented this number');
  assert.notStrictEqual(away.odds, flipPick(epl).odds);
});

test('the model own side is quoted from odds, not altPrices', () => {
  // Legacy rows have no altPrices at all; the model's side must still be takeable.
  const legacy = { ...epl, altPrices: null };
  assert.strictEqual(sidePrice(legacy, 'home'), -150);
  assert.strictEqual(sideAvailable(legacy, 'home'), true);
  assert.strictEqual(sideAvailable(legacy, 'draw'), false, 'no price = side disabled');
  assert.strictEqual(sideAvailable(legacy, 'away'), false);
});

test('a missing or partial altPrices never yields a made-up number', () => {
  assert.strictEqual(sidePrice({ ...epl, altPrices: {} }, 'draw'), null);
  assert.strictEqual(sidePrice({ ...epl, altPrices: { draw: null } }, 'draw'), null);
  assert.strictEqual(sidePrice({ ...epl, altPrices: { draw: 'abc' } }, 'draw'), null);
});

test('displayPickFor resolves a position to the side actually stored', () => {
  const on = (entry) => displayPickFor(epl, entry, null);

  // No entry, or a take: the model's own side.
  assert.strictEqual(on(undefined).pick, 'Chelsea');
  assert.strictEqual(on({ state: 'bet' }).pick, 'Chelsea');
  assert.strictEqual(on('pass').pick, 'Chelsea');

  // Faded to each of the other two.
  assert.strictEqual(on({ state: 'fade', side: 'draw' }).pick, 'Draw');
  assert.strictEqual(on({ state: 'fade', side: 'draw' }).odds, 240);
  assert.strictEqual(on({ state: 'fade', side: 'away' }).pick, 'Arsenal');
  assert.strictEqual(on({ state: 'fade', side: 'away' }).odds, 310);
});

test('a soccer moneyline NEVER falls through to the two-way approximation', () => {
  // The pre-fix bug in one assertion: a fade with no recorded side used to become
  // flipPick()'s guess. It must now resolve to a real side at a real price.
  const legacyFade = displayPickFor(epl, { state: 'fade' }, null);
  assert.strictEqual(legacyFade.pick, 'Chelsea', 'no side recorded → model side, not a guess');
  assert.strictEqual(legacyFade.odds, -150);
  assert.notStrictEqual(legacyFade.odds, 150);
});

test('the draw IS the model pick — the awkward case', () => {
  // Nick flagged this: if the model already likes the draw, the draw button must
  // still work and the other two sides must be the fades.
  const drawModel = { ...epl, pick: 'Draw', selection: 'draw', odds: 240 };
  assert.strictEqual(modelSide(drawModel), 'draw');
  assert.strictEqual(displayPickFor(drawModel, { state: 'bet', side: 'draw' }, null).pick, 'Draw');
  assert.strictEqual(displayPickFor(drawModel, { state: 'fade', side: 'home' }, null).pick, 'Chelsea');
  assert.strictEqual(displayPickFor(drawModel, { state: 'fade', side: 'home' }, null).odds, -150);
  assert.strictEqual(displayPickFor(drawModel, { state: 'fade', side: 'away' }, null).odds, 310);
});

test('US-sports rows behave exactly as before', () => {
  // Regression guard for the shared frontend: nothing about the two-way path moved.
  const slate = [nba];
  assert.strictEqual(displayPickFor(nba, undefined, slate).pick, 'Miami Heat');
  assert.strictEqual(displayPickFor(nba, { state: 'bet' }, slate).pick, 'Miami Heat');
  const faded = displayPickFor(nba, { state: 'fade' }, slate);
  assert.strictEqual(faded.pick, 'Boston Celtics');
  assert.strictEqual(faded.odds, 150, 'still the old sign flip — deliberately unchanged');
  // A stray `side` on a US entry must be ignored, not honoured.
  assert.strictEqual(displayPickFor(nba, { state: 'fade', side: 'draw' }, slate).pick, 'Boston Celtics');
});

test('a real opposite-side row still wins over the approximation (two-way)', () => {
  const other = { ...nba, pick: 'Boston Celtics', odds: 128 };
  const faded = displayPickFor(nba, { state: 'fade' }, [nba, other]);
  assert.strictEqual(faded.odds, 128, 'real logged price beats flipPick');
});

test('grading follows the side you switched to', () => {
  const game = { league: 'EPL', away: 'Arsenal', home: 'Chelsea', status: 'in', awayScore: 1, homeScore: 1 };
  const drawn = displayPickFor(epl, { state: 'fade', side: 'draw' }, null);
  assert.strictEqual(getPickStatus(drawn, game), 'winning', 'level scoreline = the draw is winning');
  assert.strictEqual(getPickStatus(epl, game), 'losing', 'the model home side is losing while level');

  const chelseaAhead = { ...game, homeScore: 2 };
  assert.strictEqual(getPickStatus(drawn, chelseaAhead), 'losing');
  assert.strictEqual(getPickStatus(epl, chelseaAhead), 'winning');

  const arsenalAhead = { ...game, awayScore: 3 };
  const away = displayPickFor(epl, { state: 'fade', side: 'away' }, null);
  assert.strictEqual(getPickStatus(away, arsenalAhead), 'winning');
});

test('a level soccer game is a loss, not a push (unlike US sports)', () => {
  const level = { league: 'EPL', away: 'Arsenal', home: 'Chelsea', status: 'post', awayScore: 0, homeScore: 0 };
  assert.strictEqual(getPickStatus(epl, level), 'losing');
  const usLevel = { league: 'NBA', away: 'Boston Celtics', home: 'Miami Heat', status: 'in', awayScore: 90, homeScore: 90 };
  assert.strictEqual(getPickStatus(nba, usLevel), 'even', 'US tie is still even');
});

test('isDrawPick spots the draw for the crest-less chip', () => {
  assert.strictEqual(isDrawPick({ pick: 'Draw' }), true);
  assert.strictEqual(isDrawPick({ pick: ' draw ' }), true);
  assert.strictEqual(isDrawPick({ pick: 'Chelsea' }), false);
  assert.strictEqual(isDrawPick({}), false);
});
