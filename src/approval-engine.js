'use strict';
// =============================================================
// src/approval-engine.js — Pick approval / filtering layer
// Sprint 3: Candidate → Approved split
//
// Every pick passes through; nothing is discarded. Each pick is
// tagged with approval_status ('approved' | 'tracking_only') and
// a human-readable approval_reason string explaining why.
//
// Thresholds are intentionally conservative at launch — the goal
// is to separate signal from noise so the daily email surfaces
// only high-conviction plays while the full card still logs to
// Performance_Log for analysis.
// =============================================================

/**
 * Default approval thresholds per league.
 * Override per-league where we have enough ROI data to justify it.
 *
 * minEdgePct        — minimum model edge vs market (%). Derived from
 *                     game-model _edge field.
 * minMarketQuality  — minimum market quality score (0-1). Markets with
 *                     thin liquidity or stale lines score low.
 * minDataCompleteness — minimum data completeness (0-1). Ensures we
 *                       had enough stat inputs to trust the projection.
 * minConfidence     — minimum raw confidence from game-model (1-10).
 *                     Catches low-signal picks even if edge looks OK.
 * maxUncertainty    — maximum model uncertainty (0-1). High uncertainty
 *                     means wide projection spread → tracking only.
 */
// 2026-05-10 backtest sweep raised defaults 1.5→3.5 — but that sweep was
// computed against a buggy model (spread sign error + total Over bias, fixed
// 2026-05-31). The old "+ROI" signal was actually penalty-stack-shrunk units
// masking a deeper formula bug. Now that the formulas are fixed:
// 2026-06-01: default 3.5→2.5, MLB 4.0→2.5 / conf 7→4 / mktQuality 0.35→0.30,
// NBA 3.5→2.5. NHL untouched (only profitable league pre-fix, don't disturb).
// Expected: approved volume rises, more samples per segment for the optimizer,
// modifiers and calibration finally have data to learn from.
const DEFAULT_THRESHOLDS = {
  minEdgePct:          2.5,
  minMarketQuality:    0.3,
  minDataCompleteness: 0.3,
  minConfidence:       4,
  maxUncertainty:      0.75,
};

const LEAGUE_OVERRIDES = {
  NHL: {
    // NHL has been our strongest league — loosen slightly. Untouched 2026-06-01.
    minEdgePct:       2.5,
    minConfidence:    3,
  },
  NBA: {
    // 2026-06-01: dropped minEdgePct 3.5→2.5 (matches new default). Keep the
    // tighter maxUncertainty 0.65 since playoff variance is real.
    // NBA moneyline still routed through per-market block in shouldApprove.
    minEdgePct:       2.5,
    maxUncertainty:   0.65,
  },
  MLB: {
    // 2026-06-01: hard reset. The 4.0/7/0.35 stack was set when the model was
    // structurally picking favorites + Overs (now fixed). With formula bugs
    // resolved, no justification for tighter-than-default MLB thresholds.
    // Will reevaluate after 14d of clean grading.
    minEdgePct:       2.5,
    minConfidence:    4,
    minMarketQuality: 0.30,
  },
  NFL: {
    // Limited recent data — use defaults
  },
};

/**
 * Merge default thresholds with league-specific overrides.
 */
function getThresholds(league) {
  return { ...DEFAULT_THRESHOLDS, ...(LEAGUE_OVERRIDES[league] || {}) };
}

/**
 * Determine if a single pick should be approved.
 * Returns { approved: boolean, reasons: string[] }
 */
function shouldApprove(pick, thresholds, league) {
  const reasons = [];
  const edge = pick._edge ?? null;
  const uncertainty = pick._uncertainty ?? null;
  const mktQuality = pick._mktQuality ?? null;
  const dataCompleteness = pick._dataCompleteness ?? null;
  const confidence = parseInt(pick.confidence) || 0;
  const betType = (pick.betType || '').toLowerCase();

  // 1. Edge check
  if (edge !== null && edge < thresholds.minEdgePct) {
    reasons.push(`edge ${edge.toFixed(1)}% < min ${thresholds.minEdgePct}%`);
  }

  // 2. Market quality check
  if (mktQuality !== null && mktQuality < thresholds.minMarketQuality) {
    reasons.push(`mktQuality ${mktQuality.toFixed(2)} < min ${thresholds.minMarketQuality}`);
  }

  // 3. Data completeness check
  if (dataCompleteness !== null && dataCompleteness < thresholds.minDataCompleteness) {
    reasons.push(`dataCompleteness ${dataCompleteness.toFixed(2)} < min ${thresholds.minDataCompleteness}`);
  }

  // 4. Confidence floor
  if (confidence < thresholds.minConfidence) {
    reasons.push(`confidence ${confidence} < min ${thresholds.minConfidence}`);
  }

  // 5. Uncertainty ceiling
  if (uncertainty !== null && uncertainty > thresholds.maxUncertainty) {
    reasons.push(`uncertainty ${uncertainty.toFixed(2)} > max ${thresholds.maxUncertainty}`);
  }

  // 6. Special case: NBA moneyline is contaminated — tracking only
  if (league === 'NBA' && betType === 'moneyline') {
    reasons.push('NBA moneyline data contaminated (stake=0 bug)');
  }

  // 7. Backfill picks (confidence 1%, units 0.01) are always tracking
  if (confidence <= 1) {
    reasons.push('backfill pick (confidence ≤1%)');
  }

  return {
    approved: reasons.length === 0,
    reasons,
  };
}

/**
 * Apply approval filters to an array of picks.
 * Mutates each pick in-place by adding:
 *   - approval_status:  'approved' | 'tracking_only'
 *   - approval_reason:  human-readable string (empty for approved)
 *
 * @param {Object[]} picks - array of pick objects from game-model
 * @param {string}   league - 'MLB', 'NBA', 'NHL', 'NFL'
 * @returns {Object[]} same picks array (mutated)
 */
function applyApprovalFilters(picks, league) {
  if (!picks || picks.length === 0) return picks;

  const thresholds = getThresholds(league);
  let approved = 0;
  let tracking = 0;

  for (const pick of picks) {
    const result = shouldApprove(pick, thresholds, league);
    if (result.approved) {
      pick.approval_status = 'approved';
      pick.approval_reason = '';
      pick.pick_purpose = 'bet';
      approved++;
    } else {
      pick.approval_status = 'tracking_only';
      pick.approval_reason = result.reasons.join('; ');
      // Tag low-edge picks as data-gathering: they exist for the pick coverage
      // rule (every game must produce picks) not because we see betting value.
      // This enables filtering analysis to "genuine edges" vs "data collection".
      const edge = pick._edge ?? 0;
      pick.pick_purpose = edge < 1.0 ? 'data_gathering' : 'tracking';
      tracking++;
    }
  }

  console.log(`[approval] ${league}: ${approved} approved, ${tracking} tracking-only out of ${picks.length} total`);
  return picks;
}

module.exports = {
  applyApprovalFilters,
  getThresholds,
  shouldApprove,
  DEFAULT_THRESHOLDS,
  LEAGUE_OVERRIDES,
};
