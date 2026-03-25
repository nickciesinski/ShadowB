'use strict';
// =============================================================
// src/triggers.js — Trigger orchestration
// Each GitHub Actions workflow calls: node src/triggers.js <triggerName>
// Replaces: 8TriggerSystem (Apps Script)
// =============================================================

const { validateConfig } = require('./config');
const { updatePlayerStats, updateTeamStats, fetchOddsAndGrade } = require('./data-collection');
const { generateMLBPredictions, generateNBAPredictions, takeCLVSnapshot } = require('./predictions');
const { sendDailyPicksEmail, sendPerformanceSummary } = require('./emails');
const { updatePlayerProps, updatePlatformCombos } = require('./props');
const { updatePlayerTiers } = require('./player-tiers');

// ── Trigger Map ──────────────────────────────────────────────────
// Maps trigger names (passed as CLI arg) to their functions.
// Each trigger corresponds to one GitHub Actions workflow file.

const TRIGGERS = {
  // Trigger 1: 3:30 AM ET → Update player stats from ESPN
  trigger1: updatePlayerStats,

  // Trigger 2: 4:00 AM ET → Update team stats from ESPN
  trigger2: updateTeamStats,

  // Trigger 3: 4:30 AM ET → Fetch odds, grade yesterday, CLV snapshot
  trigger3: async () => {
    await fetchOddsAndGrade();
    await takeCLVSnapshot();
  },

  // Trigger 4: 5:00 AM ET → MLB + NBA predictions
  trigger4: async () => {
    await generateMLBPredictions();
    await generateNBAPredictions();
  },

  // Trigger 5: 5:30 AM ET → NBA predictions (if trigger 4 is slow)
  trigger5: generateNBAPredictions,

  // Trigger 6: 6:00 AM ET → Player props
  trigger6: updatePlayerProps,

  // Trigger 7: 6:15 AM ET → Platform combos
  trigger7: updatePlatformCombos,

  // Trigger 8: 6:20 AM ET → Player tiers
  trigger8: updatePlayerTiers,

  // Trigger 9: 6:30 AM ET → Send daily picks email
  trigger9: sendDailyPicksEmail,

  // Trigger 10: 12:00 PM ET → Midday odds refresh
  trigger10: fetchOddsAndGrade,

  // Trigger 11: 6:00 PM ET → Evening odds refresh + CLV
  trigger11: async () => {
    await fetchOddsAndGrade();
    await takeCLVSnapshot();
  },

  // Trigger 12: 11:00 PM ET → Post-game grading (placeholder)
  trigger12: async () => {
    console.log('[triggers] trigger12: Post-game grading — implement in Phase 2');
  },

  // Trigger 13: Sunday 8:00 PM ET → Weekly performance summary
  trigger13: sendPerformanceSummary,
};

// ── Main Entry Point ─────────────────────────────────────────────

async function main() {
  const triggerName = process.argv[2];

  if (!triggerName) {
    console.error('Usage: node src/triggers.js <triggerName>');
    console.error('Available triggers:', Object.keys(TRIGGERS).join(', '));
    process.exit(1);
  }

  const triggerFn = TRIGGERS[triggerName];
  if (!triggerFn) {
    console.error(`Unknown trigger: ${triggerName}`);
    console.error('Available triggers:', Object.keys(TRIGGERS).join(', '));
    process.exit(1);
  }

  console.log(`[triggers] Starting ${triggerName} at ${new Date().toISOString()}`);

  try {
    validateConfig();
    await triggerFn();
    console.log(`[triggers] ${triggerName} completed successfully at ${new Date().toISOString()}`);
    process.exit(0);
  } catch (err) {
    console.error(`[triggers] ${triggerName} FAILED:`, err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
