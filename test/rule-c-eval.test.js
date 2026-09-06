'use strict';
// Offline tests for src/rule-c-eval.js — the out-of-sample scoring of the
// pre-registered rule C. Pure arithmetic; no network, no Supabase, no Sheets.

const test = require('node:test');
const assert = require('node:assert');
const {
  PRE_REG_ISO, meanSd, tOfMean, rowsNeeded, clusterByGame,
  summarizeBucket, verdictOf, evaluateRuleC, welchT, separationVerdictOf,
} = require('../src/rule-c-eval');

const row = (date, gameKey, netEdgePp, eligible) => ({ date, gameKey, netEdgePp, eligible });

test('meanSd: empty, single, and known values', () => {
  assert.deepStrictEqual(meanSd([]), { n: 0, mean: null, sd: null });
  assert.deepStrictEqual(meanSd([5]), { n: 1, mean: 5, sd: null });
  const r = meanSd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.strictEqual(r.n, 8);
  assert.strictEqual(r.mean, 5);
  assert.ok(Math.abs(r.sd - 2.13809) < 1e-4); // sample sd, n-1
});

test('meanSd ignores non-numeric entries rather than producing NaN', () => {
  const r = meanSd([1, null, 'x', undefined, 3]);
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.mean, 2);
});

test('tOfMean: null when unresolvable, correct sign otherwise', () => {
  assert.strictEqual(tOfMean([]), null);
  assert.strictEqual(tOfMean([1]), null);        // n<2
  assert.strictEqual(tOfMean([3, 3, 3]), null);  // sd 0 -> undefined, not Infinity
  assert.ok(tOfMean([1, 2, 3]) > 0);
  assert.ok(tOfMean([-1, -2, -3]) < 0);
});

test('rowsNeeded: scales with the square of sd/mean, null on degenerate input', () => {
  assert.strictEqual(rowsNeeded(0, 1), null);
  assert.strictEqual(rowsNeeded(1, 0), null);
  assert.strictEqual(rowsNeeded(null, 1), null);
  // mean 1, sd 10 -> (1.96*10/1)^2 = 384.16 -> 385
  assert.strictEqual(rowsNeeded(1, 10), 385);
  // halving the effect quadruples the requirement
  assert.strictEqual(rowsNeeded(0.5, 10), 1537);
});

test('clusterByGame collapses one game to one observation', () => {
  // three tickets on one game, mean 2 -> a single observation of 2
  const c = clusterByGame([
    row('2026-09-01', 'g1', 1, true),
    row('2026-09-01', 'g1', 2, true),
    row('2026-09-01', 'g1', 3, true),
  ]);
  assert.deepStrictEqual(c, [2]);
});

test('THE TRAP: clustering shrinks t versus counting tickets as independent', () => {
  // 30 games, 3 correlated tickets each. Unclustered n=90 inflates t ~sqrt(3).
  const rows = [];
  for (let g = 0; g < 30; g++) {
    const v = g % 2 === 0 ? 0.6 : -0.2; // mean +0.2pp, real between-game spread
    for (let m = 0; m < 3; m++) rows.push(row('2026-09-01', `g${g}`, v, true));
  }
  const clusteredT = tOfMean(clusterByGame(rows));
  const unclusteredT = tOfMean(rows.map(r => r.netEdgePp));
  assert.ok(clusteredT > 0 && unclusteredT > 0);
  assert.ok(unclusteredT > clusteredT * 1.5,
    `expected pseudo-replication to inflate t (clustered ${clusteredT}, unclustered ${unclusteredT})`);
});

test('rows with no game key stay separate observations, not one giant fake game', () => {
  const c = clusterByGame([
    row('2026-09-01', null, 1, true),
    row('2026-09-01', '', 3, true),
  ]);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c.sort(), [1, 3]);
});

test('summarizeBucket: not resolvable below minGames even with a clean signal', () => {
  const rows = [];
  for (let g = 0; g < 10; g++) rows.push(row('2026-09-01', `g${g}`, g % 2 ? 1 : 2, true));
  const s = summarizeBucket(rows, { minGames: 30 });
  assert.strictEqual(s.tickets, 10);
  assert.strictEqual(s.games, 10);
  assert.strictEqual(s.resolvable, false);
  assert.ok(s.gamesNeeded > 0);
});

test('evaluateRuleC splits in-sample from forward and never pools them', () => {
  const rows = [
    row('2026-08-30', 'a', -5, true),   // day before pre-registration
    row('2026-08-31', 'b', +5, true),   // the pre-reg date itself is forward
    row('2026-09-01', 'c', +5, false),
  ];
  const out = evaluateRuleC(rows, { minGames: 1 });
  assert.strictEqual(out.preReg, PRE_REG_ISO);
  assert.strictEqual(out.inSample.eligible.tickets, 1);
  assert.strictEqual(out.inSample.eligible.meanNetEdgePp, -5);
  assert.strictEqual(out.forward.eligible.tickets, 1);
  assert.strictEqual(out.forward.eligible.meanNetEdgePp, +5);
  assert.strictEqual(out.forward.ineligible.tickets, 1);
  // the negative in-sample number must not leak into the forward mean
  assert.ok(out.forward.eligible.meanNetEdgePp > 0);
});

test('unlabelled rows are counted and excluded from both buckets', () => {
  const out = evaluateRuleC([
    row('2026-09-01', 'a', 1, null),
    row('2026-09-01', 'b', 1, undefined),
    { date: 'not-a-date', gameKey: 'c', netEdgePp: 1, eligible: true },
    row('2026-09-01', 'd', 1, true),
  ], { minGames: 1 });
  assert.strictEqual(out.unlabelled, 3);
  assert.strictEqual(out.forward.eligible.tickets, 1);
  assert.strictEqual(out.forward.ineligible.tickets, 0);
});

test('a truthy-but-not-boolean stamp is treated as unlabelled, not eligible', () => {
  const out = evaluateRuleC([{ date: '2026-09-01', gameKey: 'a', netEdgePp: 1, eligible: 'true' }],
    { minGames: 1 });
  assert.strictEqual(out.unlabelled, 1);
  assert.strictEqual(out.forward.eligible.tickets, 0);
});

test('verdict: cannot say CONFIRMED on a positive mean with a weak t', () => {
  // 40 games, positive mean, but huge spread -> t well under 2
  const rows = [];
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-01', `g${g}`, g % 2 ? 20 : -19, true));
  const out = evaluateRuleC(rows, { minGames: 30 });
  assert.ok(out.forward.eligible.meanNetEdgePp > 0);
  assert.ok(Math.abs(out.forward.eligible.t) < 1.96);
  assert.match(out.verdict, /inconclusive/);
});

test('verdict: REJECTED when the forward bucket is significantly negative', () => {
  const rows = [];
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-02', `g${g}`, g % 2 ? -1.4 : -1.6, true));
  const out = evaluateRuleC(rows, { minGames: 30 });
  assert.match(out.verdict, /REJECTED/);
});

test('verdict: CONFIRMED only with enough games, positive mean and t >= 1.96', () => {
  const rows = [];
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-02', `g${g}`, g % 2 ? 1.4 : 1.6, true));
  const out = evaluateRuleC(rows, { minGames: 30 });
  assert.match(out.verdict, /CONFIRMED/);
});

test('empty input is a clean null, not a crash', () => {
  const out = evaluateRuleC([]);
  assert.strictEqual(out.forward.eligible.games, 0);
  assert.strictEqual(out.verdict, 'no forward rows yet');
  assert.strictEqual(evaluateRuleC(null).unlabelled, 0);
});

test('the pre-registration date is the one in config provenance, not a fresh guess', () => {
  assert.strictEqual(PRE_REG_ISO, '2026-08-31');
});

// ── Wiring: ledger rows -> scorer, via the report's own mapper ──────────
const report = require('../scripts/clean-era-report');
const { supaRowsToArrayRows } = require('../scripts/weekly-threshold-tune');

test('supaRowsToArrayRows carries game and a strict rule_c_eligible boolean', () => {
  const [a, b, c] = supaRowsToArrayRows([
    { date: '2026-09-02', league: 'MLB', game: 'A @ B', clv_basis: 'novig',
      net_edge_pp: -0.012, rule_c_eligible: true },
    { date: '2026-09-02', league: 'MLB', game: 'C @ D', clv_basis: 'novig',
      net_edge_pp: 0.004, rule_c_eligible: false },
    { date: '2026-09-02', league: 'MLB', game: 'E @ F', clv_basis: 'novig',
      net_edge_pp: 0.004, rule_c_eligible: null },
  ]);
  assert.strictEqual(a[37], 'A @ B');
  assert.strictEqual(a[38], true);
  assert.strictEqual(b[38], false);
  assert.strictEqual(c[38], '', 'a null stamp must stay unlabelled, not become false');
  assert.ok(Math.abs(a[35] - -1.2) < 1e-9, 'net edge is scaled to points');
});

test('ruleCRows clusters the three markets of one game into one observation', () => {
  const mk = (market, netEdge) => {
    const row = new Array(39).fill('');
    row[0] = '9/2/2026'; row[1] = 'MLB'; row[2] = market;
    row[35] = netEdge; row[37] = 'A @ B'; row[38] = true;
    return row;
  };
  const mapped = report.ruleCRows([mk('moneyline', 1), mk('spread', 2), mk('total', 3)],
    new Date(2026, 5, 3));
  assert.strictEqual(mapped.length, 3);
  assert.strictEqual(new Set(mapped.map(r => r.gameKey)).size, 1,
    'same game on the same date must share one cluster key');
  const out = evaluateRuleC(mapped, { minGames: 1 });
  assert.strictEqual(out.forward.eligible.tickets, 3);
  assert.strictEqual(out.forward.eligible.games, 1);
  assert.strictEqual(out.forward.eligible.meanNetEdgePp, 2);
});

test('ruleCRows keeps the same matchup on different dates as different games', () => {
  const mk = (date) => {
    const row = new Array(39).fill('');
    row[0] = date; row[1] = 'MLB'; row[35] = 1; row[37] = 'A @ B'; row[38] = true;
    return row;
  };
  const mapped = report.ruleCRows([mk('9/2/2026'), mk('9/3/2026')], new Date(2026, 5, 3));
  assert.strictEqual(new Set(mapped.map(r => r.gameKey)).size, 2);
});

test('ruleCRows leaves a missing net edge as null instead of scoring it break-even', () => {
  const row = new Array(39).fill('');
  row[0] = '9/2/2026'; row[1] = 'MLB'; row[37] = 'A @ B'; row[38] = true; // row[35] stays ''
  const mapped = report.ruleCRows([row], new Date(2026, 5, 3));
  assert.strictEqual(mapped[0].netEdgePp, null);
  const out = evaluateRuleC(mapped, { minGames: 1 });
  assert.strictEqual(out.forward.eligible.games, 0, 'no measurable net edge = no observation');
});

test('the report table renders both eras and never sums them', () => {
  const rows = [];
  for (let g = 0; g < 5; g++) {
    for (const d of ['8/20/2026', '9/2/2026']) {
      const row = new Array(39).fill('');
      row[0] = d; row[1] = 'MLB'; row[35] = d === '8/20/2026' ? -3 : +1;
      row[37] = `G${g}`; row[38] = true;
      rows.push(row);
    }
  }
  const ev = evaluateRuleC(report.ruleCRows(rows, new Date(2026, 5, 3)), { minGames: 30 });
  const md = report.ruleCTable(ev);
  assert.match(md, /In-sample \(before pre-registration\)/);
  assert.match(md, /Forward \(the real test\)/);
  assert.strictEqual(ev.inSample.eligible.meanNetEdgePp, -3);
  assert.strictEqual(ev.forward.eligible.meanNetEdgePp, 1);
  assert.match(md, /more games/, 'an under-powered bucket must say what it still needs');
  assert.doesNotMatch(md, /resolved/, 'five games is not resolved');
});

// ── Separation: does the filter sort tickets, regardless of profitability ──

test('welchT: null when either side is too thin or has no spread', () => {
  assert.strictEqual(welchT([1], [1, 2, 3]), null);
  assert.strictEqual(welchT([], []), null);
  assert.strictEqual(welchT([2, 2, 2], [1, 1, 1]), null); // both sd 0
});

test('welchT reproduces a hand-computed two-sample statistic', () => {
  const a = [1, 2, 3, 4, 5];   // mean 3, sd sqrt(2.5)
  const b = [0, 1, 2];         // mean 1, sd 1
  const r = welchT(a, b);
  const se = Math.sqrt(2.5 / 5 + 1 / 3);
  assert.ok(Math.abs(r.diff - 2) < 1e-12);
  assert.ok(Math.abs(r.se - se) < 1e-12);
  assert.ok(Math.abs(r.t - 2 / se) < 1e-12);
});

test('separation is reported independently of profitability', () => {
  // Both buckets lose money; eligible loses much less. The rule sorts
  // correctly AND is unbettable — the report must be able to say both.
  const rows = [];
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-02', `e${g}`, g % 2 ? -0.1 : -0.3, true));
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-02', `i${g}`, g % 2 ? -1.5 : -1.7, false));
  const out = evaluateRuleC(rows, { minGames: 30 });
  assert.ok(out.forward.separation.diff > 1, 'eligible bucket is ~1.4pp better');
  assert.ok(out.forward.separation.t > 1.96);
  assert.match(out.separationVerdict, /separates out-of-sample/);
  assert.ok(out.forward.eligible.meanNetEdgePp < 0, 'and it is still losing money');
  assert.match(out.verdict, /REJECTED|inconclusive/);
});

test('separation verdict refuses to claim a filter that sorts backwards', () => {
  const rows = [];
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-02', `e${g}`, g % 2 ? -1.5 : -1.7, true));
  for (let g = 0; g < 40; g++) rows.push(row('2026-09-02', `i${g}`, g % 2 ? -0.1 : -0.3, false));
  const out = evaluateRuleC(rows, { minGames: 30 });
  assert.match(out.separationVerdict, /BACKWARDS/);
});

test('separationVerdictOf handles a missing measurement without crashing', () => {
  assert.strictEqual(separationVerdictOf(null), 'separation not measurable yet');
  assert.match(separationVerdictOf({ diff: 0.1, se: 1, t: 0.1 }), /not established/);
});

test('separation is also clustered by game, not by ticket', () => {
  // Three tickets per game on both sides; clustering must halve nothing but
  // must not treat 120 tickets as 120 observations.
  const rows = [];
  for (let g = 0; g < 40; g++) {
    for (let m = 0; m < 3; m++) {
      rows.push(row('2026-09-02', `e${g}`, g % 2 ? -0.1 : -0.3, true));
      rows.push(row('2026-09-02', `i${g}`, g % 2 ? -1.5 : -1.7, false));
    }
  }
  const out = evaluateRuleC(rows, { minGames: 30 });
  assert.strictEqual(out.forward.eligible.tickets, 120);
  assert.strictEqual(out.forward.eligible.games, 40);
});

test('the table says "resolved" only when the bucket actually produced an answer', () => {
  // 40 games, plenty of sample, but a t of ~-0.5: sample is enough to LOOK,
  // not enough to CONCLUDE. Printing "resolved" here would announce a verdict.
  const rows = [];
  for (let g = 0; g < 40; g++) {
    const x = new Array(39).fill('');
    x[0] = '9/2/2026'; x[1] = 'MLB'; x[35] = g % 2 ? 2.1 : -2.5; x[37] = `E${g}`; x[38] = true;
    rows.push(x);
  }
  const ev = evaluateRuleC(report.ruleCRows(rows, new Date(2026, 5, 3)), { minGames: 30 });
  assert.strictEqual(ev.forward.eligible.games, 40);
  assert.ok(Math.abs(ev.forward.eligible.t) < 1.96);
  const line = report.ruleCTable(ev).split('\n').find(l => l.includes('Forward') && l.includes('| eligible |'));
  assert.doesNotMatch(line, /resolved/);
  assert.match(line, /more games/);
});
