'use strict';
// scripts/clv-lib.js — shared CLV (closing-line value) math.
// One source of truth for the report (clean-era-report.js) and the
// CLV-aware threshold tuner. Pure, dependency-free, offline-testable.

function impliedProb(odds) {
  const o = parseFloat(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

// CLV in implied-probability percentage points. +1.5 = the close implied 1.5pp
// more probability on our side than the price we took (we beat the close).
function clvPoints(openOdds, closeOdds) {
  const oi = impliedProb(openOdds), ci = impliedProb(closeOdds);
  if (oi == null || ci == null) return null;
  return (ci - oi) * 100;
}

function emptyClv() { return { n: 0, beats: 0, sumPts: 0 }; }

function addClv(acc, pts) {
  if (pts == null) return acc;
  acc.n++; if (pts > 0) acc.beats++; acc.sumPts += pts; return acc;
}

function clvFinalize(c) {
  return {
    n: c.n,
    beatPct: c.n ? Math.round((c.beats / c.n) * 1000) / 10 : null,
    avgPts: c.n ? Math.round((c.sumPts / c.n) * 100) / 100 : null,
  };
}

module.exports = { impliedProb, clvPoints, emptyClv, addClv, clvFinalize };
