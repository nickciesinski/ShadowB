'use strict';
/**
 * src/cf-gate.js — R5.1 counterfactual out-of-sample APPLY GATE (pure).
 *
 * The weekly weight optimizer (scripts/auto-apply-weights.js) already runs a
 * walk-forward holdout + promotion state machine. This adds the last piece the
 * roadmap (R5.1) asked for: before a winning weight change is applied, verify it
 * with the *rigorous* counterfactual backtest (src/backtesting.js
 * counterfactualBacktest — re-runs the actual model over historical snapshots,
 * not the score-ratio approximation the sweep uses) and refuse to apply unless
 * that independent re-run also shows out-of-sample lift.
 *
 * GUARD ONLY. This module can only turn an apply the rest of the pipeline
 * already approved into a SKIP. It never approves, never loosens, never enables
 * an apply that other gates rejected, and never touches the live pick/grade
 * path. It runs purely as an extra AND-condition on the optimizer's apply step.
 *
 * Ships INERT: config/cf-gate.json enabled=false by default, so the gate is a
 * no-op (and the counterfactual is never even run) until deliberately flipped.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  enabled: false,
  minSample: 50,       // decided picks in the counterfactual baseline
  minRoiLift: 0,       // percentage points; require non-negative OOS ROI lift
  minNetUnitsLift: 0,  // units; require non-negative OOS net-unit lift
};

/**
 * Load config/cf-gate.json (or a supplied path). Fail-safe: a missing or
 * malformed file returns the disabled default, so a config error can never
 * itself cause the gate to block an apply.
 */
function loadGateConfig(configPath) {
  const p = configPath || path.join(__dirname, '..', 'config', 'cf-gate.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      enabled: raw.enabled === true,
      minSample: Number.isFinite(raw.minSample) ? raw.minSample : DEFAULT_CONFIG.minSample,
      minRoiLift: Number.isFinite(raw.minRoiLift) ? raw.minRoiLift : DEFAULT_CONFIG.minRoiLift,
      minNetUnitsLift: Number.isFinite(raw.minNetUnitsLift) ? raw.minNetUnitsLift : DEFAULT_CONFIG.minNetUnitsLift,
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Decided sample from a "W-L" or "W-L-T" record string. "130-76" -> 206.
 * Uses wins+losses (ignores pushes). Junk -> 0.
 */
function sampleFromRecord(record) {
  if (typeof record !== 'string') return 0;
  const parts = record.split('-').map(n => parseInt(n, 10));
  const w = parts[0], l = parts[1];
  if (!Number.isFinite(w) || !Number.isFinite(l)) return 0;
  return w + l;
}

/**
 * Evaluate the counterfactual gate.
 * @param {object|null} cfSummary  counterfactualBacktest() return, or null
 * @param {object} config          loadGateConfig() result
 * @returns {{pass:boolean, gated:boolean, reason:string,
 *            sample?:number, roiLift?:number, netUnitsLift?:number}}
 *          pass:true = do not block (either inert, or lift verified).
 */
function evaluateCounterfactualGate(cfSummary, config) {
  const cfg = config || DEFAULT_CONFIG;

  // Inert: gate off -> pure no-op, never blocks.
  if (!cfg.enabled) {
    return { pass: true, gated: false, reason: 'cf-gate disabled (inert) — no-op' };
  }

  // Enabled: an apply now REQUIRES a valid counterfactual that proves OOS lift.
  // No proof (null/malformed) => block. This is the whole point of a hard gate.
  if (!cfSummary || !cfSummary.baseline || !cfSummary.diff) {
    return { pass: false, gated: true,
      reason: 'counterfactual unavailable/malformed — cannot verify out-of-sample lift' };
  }

  const sample = sampleFromRecord(cfSummary.baseline.record);
  const roiLift = Number(cfSummary.diff.roi);
  const netUnitsLift = Number(cfSummary.diff.netUnits);

  if (sample < cfg.minSample) {
    return { pass: false, gated: true, sample,
      reason: `counterfactual sample ${sample} < required ${cfg.minSample}` };
  }
  if (!Number.isFinite(roiLift) || !Number.isFinite(netUnitsLift)) {
    return { pass: false, gated: true, sample,
      reason: 'counterfactual lift metrics missing/non-numeric' };
  }
  if (roiLift < cfg.minRoiLift || netUnitsLift < cfg.minNetUnitsLift) {
    return { pass: false, gated: true, sample, roiLift, netUnitsLift,
      reason: `counterfactual OOS lift below floor (ROI ${roiLift} < ${cfg.minRoiLift} `
        + `or netUnits ${netUnitsLift} < ${cfg.minNetUnitsLift})` };
  }

  return { pass: true, gated: true, sample, roiLift, netUnitsLift,
    reason: `counterfactual OOS lift clears gate (ROI +${roiLift}, netUnits +${netUnitsLift}, n=${sample})` };
}

module.exports = { loadGateConfig, evaluateCounterfactualGate, sampleFromRecord, DEFAULT_CONFIG };
