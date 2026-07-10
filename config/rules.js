'use strict';
// =============================================================
// config/rules.js — HARD INVARIANTS (never optimizer-tunable)
//
// These are Nick's structural rules. The optimizer may freely tune
// every weight and param in config/model-params.*.json, EXCEPT the
// keys/behaviours encoded here. Nothing in the auto-tuning path may
// write these.
// =============================================================

// Structural rules enforced by the prediction/approval pipeline.
const INVARIANTS = {
  // Every game must produce a pick (low-confidence => tiny stake, never dropped).
  forceAtLeastOnePick: true,
  // Every game must carry a pick on all three markets.
  requiredMarkets: ['moneyline', 'spread', 'total'],
  // Stake floor so low-confidence picks are still placed, never zeroed out.
  minUnitsFloor: 0.01,
  // Coverage cap is effectively unlimited; the optimizer can't throttle picks.
  maxPicksPerDayFloor: 99,
};

// Param keys the optimizer must NEVER modify (they encode the rules above).
// Manual edits to model-params.*.json are still honoured — this only blocks
// the auto-tuner.
const LOCKED_PARAM_KEYS = new Set([
  'param_force_at_least_one_pick',
  'param_min_units_to_bet',
  'param_max_picks_per_day',
]);

// Safety bounds the optimizer must respect even on params it DOES own.
// The optimizer can move these, but never outside the band. Mirrors
// game-optimizer TUNABLE_FACTORS so there is one canonical source.
const PARAM_BOUNDS = {
  strength_blend_winpct:  { min: 0.10, max: 0.60 },
  strength_blend_scoring: { min: 0.10, max: 0.60 },
  strength_blend_form:    { min: 0.05, max: 0.50 },
  margin_home_advantage:  { min: 0.50, max: 1.50 },
  margin_form_influence:  { min: 0.10, max: 1.00 },
  margin_rest_impact:     { min: 0.30, max: 2.00 },
  total_market_anchor:    { min: 0.90, max: 0.98 },
  total_pace_dampening:   { min: 0.05, max: 0.80 },
  confidence_power:       { min: 0.80, max: 2.50 },
  csv_dampen:             { min: 0.10, max: 0.60 },
  goalie_adj_scale:       { min: 0.25, max: 0.75 },  // 2026-07-09: NHL starting-goalie signal (game-optimizer.js graduation rules)
};

function isLockedKey(key) {
  return LOCKED_PARAM_KEYS.has(String(key || '').trim());
}

/** Clamp a tunable factor (bare name, no param_auto_ prefix) to its safe band. */
function clampFactor(name, value) {
  const b = PARAM_BOUNDS[name];
  if (!b || !isFinite(value)) return value;
  return Math.max(b.min, Math.min(b.max, value));
}

module.exports = { INVARIANTS, LOCKED_PARAM_KEYS, PARAM_BOUNDS, isLockedKey, clampFactor };
