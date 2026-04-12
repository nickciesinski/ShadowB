'use strict';
// =============================================================
// src/triggers.js — Trigger orchestration
// Each GitHub Actions workflow calls: node src/triggers.js <triggerName>
// Replaces: 8TriggerSystem (Apps Script)
// =============================================================

const { validateConfig } = require('./config');
const { updatePlayerStats, updateTeamStats, fetchOddsAndGrade, fetchYesterdayResults } = require('./data-collection');
const { generateMLBPredictions, generateNBAPredictions, generateNHLPredictions, generateNFLPredictions, takeCLVSnapshot, gradePerformanceLog } = require('./predictions');
const { sendDailyPicksEmail, sendPerformanceSummary } = require('./emails');
const { updatePlayerProps, generatePropEdges, gradePropPicks } = require('./props');
const { updatePlayerTiers } = require('./player-tiers');
const { updatePlayerStatus } = require('./prop-status');
const { snapPropLines, gradePropEdges, updateAllPropWeights } = require('./prop-clv');
const { withMonitoring } = require('./monitoring');

// ── Trigger Map ──────────────────────────────────────────────────
// Maps trigger names (passed as CLI arg) to their functions.
// Each trigger corresponds to one GitHub Actions workflow file.
//
// Every trigger is wrapped in withMonitoring() so it writes a row to
// Trigger_Monitor + Simple_Monitor and refreshes the Dashboard header.

const TRIGGERS = {
  // Trigger 1: 3:30 AM ET → Update player stats from ESPN
  trigger1: withMonitoring('trigger1', updatePlayerStats),

  // Trigger 2: 4:00 AM ET → Update team stats from ESPN
  trigger2: withMonitoring('trigger2', updateTeamStats),

  // Trigger 3: 4:30 AM ET → Fetch odds, grade yesterday, CLV snapshot
  trigger3: withMonitoring('trigger3', async () => {
    await fetchOddsAndGrade();
    await takeCLVSnapshot();
  }),

  // Trigger 4: 5:00 AM ET → All sport predictions (MLB, NBA, NHL, NFL)
  trigger4: withMonitoring('trigger4', async () => {
    await generateMLBPredictions();
    await generateNBAPredictions();
    await generateNHLPredictions();
    await generateNFLPredictions();
  }),

  // Trigger 5: DISABLED — trigger4 already runs all 4 sports sequentially.
  // Running NHL again here caused 49 duplicate picks in the Performance Log.
  // Kept as no-op so the workflow dispatch doesn't error.
  trigger5: withMonitoring('trigger5', async () => {
    console.log('[trigger5] No-op — all sports handled by trigger4. See commit note.');
  }),

  // Trigger 6: 6:00 AM ET → Status check + Player props
  trigger6: withMonitoring('trigger6', async () => {
    await updatePlayerStatus();   // detect scratches/injuries before fetching props
    await updatePlayerProps();
  }),

  // Trigger 7: 6:15 AM ET → Compute prop edges + snapshot opening lines for CLV
  trigger7: withMonitoring('trigger7', async () => {
    await generatePropEdges();
    await snapPropLines();  // archive opening edges for CLV comparison tonight
  }),

  // Trigger 8: 6:20 AM ET → Player tiers
  trigger8: withMonitoring('trigger8', updatePlayerTiers),

  // Trigger 9: 6:30 AM ET → Send daily picks email
  trigger9: withMonitoring('trigger9', sendDailyPicksEmail),

  // Trigger 10: 12:00 PM ET → Midday odds refresh
  trigger10: withMonitoring('trigger10', fetchOddsAndGrade),

  // Trigger 11: 6:00 PM ET → Evening odds refresh + CLV
  trigger11: withMonitoring('trigger11', async () => {
    await fetchOddsAndGrade();
    await takeCLVSnapshot();
  }),

  // Trigger 12: 11:00 PM ET → Fetch yesterday's scores + grade bets + grade prop CLV
  trigger12: withMonitoring('trigger12', async () => {
    await fetchYesterdayResults();
    await gradePerformanceLog();
    await gradePropEdges();  // compare opening vs closing prop lines for CLV grading
  }),

  // Trigger 13: Sunday 8:00 PM ET → Weekly performance summary
  trigger13: withMonitoring('trigger13', sendPerformanceSummary),

  // Trigger 14: 11:30 PM ET → Nightly prop weight auto-update (CLV-based)
  trigger14: withMonitoring('trigger14', updateAllPropWeights),
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
