'use strict';
// =============================================================
// src/split-metrics.js — directional split + ROI from Performance Log
//
// Shared by the optimizer's objective penalty and the drift-guard
// circuit-breaker. Pure functions over Performance Log rows so they
// are trivially unit-testable offline.
//
// Performance Log columns (0-indexed):
//   0 date, 1 league, 2 market, 3 away, 4 home, 7 pick,
//   9 odds, 10 units, 16 result(W/L/P), 17 unit_return
// =============================================================

function parseLogDate(raw) {
  const m = String(raw || '').trim().match(/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

/**
 * Compute directional splits and ROI per market for one league over the
 * last `days`. Counts every PLACED pick for the split %, and uses graded
 * (W/L) rows with unit_return for ROI.
 *
 * @returns {{moneyline:Object, spread:Object, total:Object}} each:
 *   { n, overPct, homePct, favPct, graded, roi }
 */
function computeSplits(perfRows, league, days = 7) {
  const LG = String(league || '').toUpperCase();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const acc = {
    moneyline: { n: 0, home: 0, fav: 0, graded: 0, ret: 0, staked: 0 },
    spread:    { n: 0, home: 0, fav: 0, graded: 0, ret: 0, staked: 0 },
    total:     { n: 0, over: 0, graded: 0, ret: 0, staked: 0 },
  };

  for (let i = 1; i < (perfRows ? perfRows.length : 0); i++) {
    const row = perfRows[i];
    if (!row || row.length < 11) continue;
    if (String(row[1] || '').trim().toUpperCase() !== LG) continue;

    const market = String(row[2] || '').trim().toLowerCase();
    if (!acc[market]) continue;

    const d = parseLogDate(row[0]);
    if (!d || d < cutoff) continue;

    const away = String(row[3] || '').trim();
    const home = String(row[4] || '').trim();
    const pick = String(row[7] || '').trim();
    const odds = parseInt(row[9]);
    const units = parseFloat(row[10]) || 0;
    const result = String(row[16] || '').trim();
    const unitReturn = parseFloat(row[17]) || 0;

    const a = acc[market];
    a.n++;

    if (market === 'total') {
      if (/^over/i.test(pick)) a.over++;
    } else {
      if (pick && pick === home) a.home++;
      // (pick === away counted implicitly as not-home)
      if (isFinite(odds) && odds < 0) a.fav++;
    }

    if (result === 'W' || result === 'L') {
      a.graded++;
      a.ret += unitReturn;
      a.staked += units;
    }
  }

  const pct = (x, n) => (n > 0 ? x / n : null);
  return {
    moneyline: {
      n: acc.moneyline.n,
      homePct: pct(acc.moneyline.home, acc.moneyline.n),
      favPct: pct(acc.moneyline.fav, acc.moneyline.n),
      graded: acc.moneyline.graded,
      roi: acc.moneyline.staked > 0 ? acc.moneyline.ret / acc.moneyline.staked : null,
    },
    spread: {
      n: acc.spread.n,
      homePct: pct(acc.spread.home, acc.spread.n),
      favPct: pct(acc.spread.fav, acc.spread.n),
      graded: acc.spread.graded,
      roi: acc.spread.staked > 0 ? acc.spread.ret / acc.spread.staked : null,
    },
    total: {
      n: acc.total.n,
      overPct: pct(acc.total.over, acc.total.n),
      graded: acc.total.graded,
      roi: acc.total.staked > 0 ? acc.total.ret / acc.total.staked : null,
    },
  };
}

// Drift bands (match the weekly bias-drift check).
const BANDS = {
  totalOver:  { lo: 0.38, hi: 0.62 },
  gameHome:   { lo: 0.32, hi: 0.68 },
};

/** Is a value outside [lo,hi]? */
function breaches(val, band) {
  return val != null && (val < band.lo || val > band.hi);
}

module.exports = { computeSplits, BANDS, breaches, parseLogDate };
