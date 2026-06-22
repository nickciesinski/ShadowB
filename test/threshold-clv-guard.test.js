'use strict';
// R1.2: the threshold tuner must NOT loosen a high-ROI segment whose staked
// closing-line value is negative (that's variance, not edge — the MLB-spread trap).
const test = require('node:test');
const assert = require('node:assert');
const { decideLeagueChange, leagueApprovedClv } = require('../scripts/weekly-threshold-tune');

// minimal segment shapes decideLeagueChange reads
function seg(roiPct, graded) {
  return { all: { roiPct, graded, wins: graded, losses: 0, pushes: 0 },
           approved: { roiPct, graded }, tracking: { roiPct: 0, graded: 0 } };
}
const current = { minEdgePct: 2.5, minConfidence: 4 };

test('high ROI + NEGATIVE CLV (n>=20) -> HOLD, does not loosen', () => {
  const d = decideLeagueChange('MLB', seg(21, 200), seg(20, 600), current,
    { n: 190, beatPct: 48, avgPts: -0.35 });
  assert.strictEqual(Object.keys(d.changes).length, 0, 'must not change thresholds');
  assert.ok(d.flag && /CLV/.test(d.flag), 'should flag regression risk');
});

test('high ROI + POSITIVE CLV (n>=20) -> loosens as before', () => {
  const d = decideLeagueChange('MLB', seg(21, 200), seg(20, 600), current,
    { n: 190, beatPct: 55, avgPts: 0.8 });
  assert.strictEqual(d.changes.minEdgePct, 2.0, 'loosens minEdgePct by 0.5');
});

test('high ROI + thin CLV sample (n<20) -> falls back to ROI-only loosen', () => {
  const d = decideLeagueChange('MLB', seg(21, 200), seg(20, 600), current,
    { n: 8, beatPct: 30, avgPts: -2.0 });
  assert.strictEqual(d.changes.minEdgePct, 2.0, 'thin CLV must not block the loosen');
});

test('high ROI + no CLV data at all -> unchanged legacy behavior (loosen)', () => {
  const d = decideLeagueChange('MLB', seg(21, 200), seg(20, 600), current, null);
  assert.strictEqual(d.changes.minEdgePct, 2.0);
});

test('leagueApprovedClv computes approved-only CLV from cols 9 & 31', () => {
  function row(date, lg, odds, close, appr) {
    const r = new Array(34).fill(''); r[0]=date; r[1]=lg; r[9]=odds; r[21]=appr; r[31]=close; return r;
  }
  const rows = [
    row('6/20/2026','MLB',120,-110,'approved'),   // beat
    row('6/20/2026','MLB',-110,120,'approved'),   // lost
    row('6/20/2026','MLB',-110,-110,'tracking_only'), // excluded (not approved)
  ];
  const c = leagueApprovedClv(rows, new Date(2026,5,3), 'MLB');
  assert.strictEqual(c.n, 2);
  assert.strictEqual(c.beatPct, 50);
});
