'use strict';
/**
 * src/threshold-oos-gate.js — R5.1(c) out-of-sample APPLY gate for the weekly
 * approval-threshold tuner (scripts/weekly-threshold-tune.js). Pure.
 *
 * The tuner decides on the trailing 7 days. A 7-day ROI spike is mostly
 * variance, so before it is allowed to LOOSEN a league (let more bets
 * through), this gate checks the window the decision did NOT look at — days
 * 8..30 — and asks for proof there: approved (staked) ROI above a floor,
 * average CLV at or above a floor, and average net edge (CLV - vig = expected
 * ROI per unit) at or above a floor, each on a large-enough sample.
 *
 * GUARD ONLY:
 *   - Only loosening keys can be removed. Tightening keys always pass through
 *     untouched, so the gate can never make the tuner more aggressive.
 *   - It never adds a change, never alters a value, never touches the live
 *     pick/approval path.
 *   - Ships INERT: config/threshold-oos-gate.json enabled=false. A missing or
 *     malformed config also means disabled, so a config error can never block.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  enabled: false,
  minSample: 50,       // approved decided picks in the holdout window
  minRoiPct: 0,        // holdout staked ROI must be > this (percent)
  minClvPp: 0,         // holdout avg CLV must be >= this (points)
  minNetEdgePp: 0,     // holdout avg net edge must be >= this (points)
};

// Positional columns — same layout as scripts/weekly-threshold-tune.js COL.
const COL = { DATE: 0, LEAGUE: 1, UNITS: 10, RESULT: 16, RETURN: 17, APPROVAL: 21, CLV_PTS: 33, NET_EDGE_PP: 35 };

// Direction that LOOSENS each threshold. -1 = lowering it loosens; +1 = raising it loosens.
const LOOSEN_DIRECTION = {
  minEdgePct: -1,
  minConfidence: -1,
  minMarketQuality: -1,
  minDataCompleteness: -1,
  maxUncertainty: +1,
  maxEdgePct: +1,
};

function loadGateConfig(configPath) {
  const p = configPath || path.join(__dirname, '..', 'config', 'threshold-oos-gate.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const num = (k) => (Number.isFinite(raw[k]) ? raw[k] : DEFAULT_CONFIG[k]);
    return {
      enabled: raw.enabled === true,
      minSample: num('minSample'),
      minRoiPct: num('minRoiPct'),
      minClvPp: num('minClvPp'),
      minNetEdgePp: num('minNetEdgePp'),
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function parseMDY(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
}

/**
 * Approved-bet stats for one league over [from, to) — the holdout window.
 * Windows on the pick date, exactly like the tuner's buildSegments().
 */
function holdoutStats(rows, league, from, to) {
  let decided = 0, staked = 0, ret = 0;
  let clvN = 0, clvSum = 0, neN = 0, neSum = 0;
  for (const row of rows || []) {
    const d = parseMDY(row[COL.DATE]);
    if (!d || d < from || d >= to) continue;
    if (String(row[COL.LEAGUE] || '').toUpperCase() !== league) continue;
    if (String(row[COL.APPROVAL] || '').trim().toLowerCase() !== 'approved') continue;
    const res = String(row[COL.RESULT] || '').trim().toUpperCase();
    if (res !== 'W' && res !== 'L' && res !== 'P') continue;
    const units = parseFloat(row[COL.UNITS]);
    if (!Number.isFinite(units)) continue;
    if (res !== 'P') decided++;
    staked += units;
    ret += parseFloat(row[COL.RETURN]) || 0;
    if (typeof row[COL.CLV_PTS] === 'number' && Number.isFinite(row[COL.CLV_PTS])) { clvN++; clvSum += row[COL.CLV_PTS]; }
    if (typeof row[COL.NET_EDGE_PP] === 'number' && Number.isFinite(row[COL.NET_EDGE_PP])) { neN++; neSum += row[COL.NET_EDGE_PP]; }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    decided,
    staked: r2(staked),
    roiPct: staked > 0 ? Math.round((ret / staked) * 1000) / 10 : null,
    clvN,
    avgClvPp: clvN > 0 ? r2(clvSum / clvN) : null,
    netEdgeN: neN,
    avgNetEdgePp: neN > 0 ? r2(neSum / neN) : null,
  };
}

/** Split a change set into loosening vs tightening keys relative to current. */
function classifyChanges(changes, current) {
  const loosen = [], tighten = [];
  for (const [k, v] of Object.entries(changes || {})) {
    const dir = LOOSEN_DIRECTION[k];
    const cur = current ? current[k] : undefined;
    if (dir && Number.isFinite(Number(v)) && Number.isFinite(Number(cur)) && Math.sign(Number(v) - Number(cur)) === dir) {
      loosen.push(k);
    } else {
      // Unknown keys / non-numeric / tightening are not the gate's business:
      // it only ever removes provable loosening.
      tighten.push(k);
    }
  }
  return { loosen, tighten };
}

/** Does the holdout window prove the loosening? Returns {pass, reason}. */
function holdoutVerdict(h, cfg) {
  if (!h) return { pass: false, reason: 'no holdout stats' };
  if (h.decided < cfg.minSample) return { pass: false, reason: `holdout sample ${h.decided} < ${cfg.minSample}` };
  if (h.roiPct === null || !(h.roiPct > cfg.minRoiPct)) return { pass: false, reason: `holdout staked ROI ${h.roiPct}% not > ${cfg.minRoiPct}%` };
  if (h.clvN < cfg.minSample || h.avgClvPp === null) return { pass: false, reason: `holdout CLV sample ${h.clvN} < ${cfg.minSample}` };
  if (h.avgClvPp < cfg.minClvPp) return { pass: false, reason: `holdout avg CLV ${h.avgClvPp}pp < ${cfg.minClvPp}pp` };
  if (h.netEdgeN < cfg.minSample || h.avgNetEdgePp === null) return { pass: false, reason: `holdout net-edge sample ${h.netEdgeN} < ${cfg.minSample}` };
  if (h.avgNetEdgePp < cfg.minNetEdgePp) return { pass: false, reason: `holdout avg net edge ${h.avgNetEdgePp}pp < ${cfg.minNetEdgePp}pp` };
  return { pass: true, reason: `holdout confirms (ROI ${h.roiPct}%, CLV ${h.avgClvPp}pp, net edge ${h.avgNetEdgePp}pp, n=${h.decided})` };
}

/**
 * Apply the gate to one tuner decision. Returns a NEW decision object (input
 * is not mutated) plus an `oos` summary line for the review.
 *   - disabled: decision returned unchanged; oos says what it WOULD do.
 *   - enabled, no loosening keys: unchanged.
 *   - enabled, loosening not proven: loosening keys removed, tightening kept.
 */
function applyGate(decision, current, holdout, config) {
  const cfg = config || DEFAULT_CONFIG;
  const out = { ...decision, changes: { ...(decision.changes || {}) }, reasons: [...(decision.reasons || [])] };
  const { loosen } = classifyChanges(out.changes, current);
  if (!loosen.length) { out.oos = null; return out; }

  const v = holdoutVerdict(holdout, cfg);
  if (!cfg.enabled) {
    out.oos = `inert — would ${v.pass ? 'allow' : 'BLOCK'} loosening ${loosen.join(', ')}: ${v.reason}`;
    return out;
  }
  if (v.pass) {
    out.oos = `allowed loosening ${loosen.join(', ')}: ${v.reason}`;
    return out;
  }
  for (const k of loosen) delete out.changes[k];
  out.reasons.push(`OOS gate blocked loosening ${loosen.join(', ')} — ${v.reason}`);
  out.oos = `BLOCKED loosening ${loosen.join(', ')}: ${v.reason}`;
  if (!Object.keys(out.changes).length) out.note = `loosening held by out-of-sample gate (${v.reason})`;
  return out;
}

module.exports = { loadGateConfig, holdoutStats, classifyChanges, holdoutVerdict, applyGate, DEFAULT_CONFIG, LOOSEN_DIRECTION };
