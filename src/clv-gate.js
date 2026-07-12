'use strict';
// =============================================================
// src/clv-gate.js — R1.3 CLV-beat staking gate (pure)
//
// A pick that the approval engine would otherwise APPROVE is
// downgraded to tracking_only when its league x market segment has
// sustained negative closing-line value (per config/clv-gate.json,
// built from the committed clean-era CLV report). CLV is the leading
// indicator: +ROI with -CLV is variance, not a real edge, and should
// not be staked.
//
// GUARD ONLY. This module can only DOWNGRADE approved -> tracking_only.
// It never upgrades a pick, never changes which side we pick, never
// zeroes a stake (a tracking_only pick keeps its computed units; it is
// just not staked/emailed), and the pick still logs — so the
// ML+spread+total coverage rule in config/rules.js stays satisfied.
//
// Ships inert: config.enabled defaults to false, so with the shipped
// config this is a no-op and the live approval path is unchanged.
// =============================================================
const fs = require('fs');
const path = require('path');

function normMarket(m) {
  return String(m || '').toLowerCase().trim();
}

/**
 * Pure gate decision. Given a parsed config object, decide whether the
 * league x market segment is gated. Exported separately so tests never
 * touch the filesystem.
 *
 * @param {string} league  e.g. 'NHL'
 * @param {string} market  e.g. 'moneyline' | 'spread' | 'total' (pick.betType)
 * @param {Object} config  parsed config/clv-gate.json
 * @returns {{gated:boolean, reason:string}}
 */
function isSegmentGated(league, market, config) {
  if (!config || config.enabled !== true) return { gated: false, reason: '' };
  const segs = Array.isArray(config.gated_segments) ? config.gated_segments : [];
  const lg = String(league || '').toUpperCase().trim();
  const mk = normMarket(market);
  if (!lg) return { gated: false, reason: '' };
  for (const s of segs) {
    if (!s) continue;
    const sLg = String(s.league || '').toUpperCase().trim();
    const sMk = normMarket(s.market);
    if (sLg !== lg) continue;
    // '' or '*' means "all markets in this league".
    if (sMk === '*' || sMk === '' || sMk === mk) {
      const reason = `CLV-gate: ${s.evidence || `${lg} ${sMk || 'all'} historically CLV-negative`}`;
      return { gated: true, reason };
    }
  }
  return { gated: false, reason: '' };
}

/** Load config/clv-gate.json. Any error -> inert config (enabled:false). */
function loadGateConfig() {
  try {
    const p = path.join(__dirname, '..', 'config', 'clv-gate.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (cfg && typeof cfg === 'object') ? cfg : { enabled: false };
  } catch (e) {
    return { enabled: false };
  }
}

module.exports = { isSegmentGated, loadGateConfig, normMarket };
