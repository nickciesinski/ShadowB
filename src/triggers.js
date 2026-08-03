'use strict';
// =============================================================
// src/triggers.js — Trigger orchestration
// Each GitHub Actions workflow calls: node src/triggers.js <triggerName>
// Replaces: 8TriggerSystem (Apps Script)
// =============================================================

const { validateConfig } = require('./config');
const { updatePlayerStats, updateTeamStats, fetchOddsAndGrade, fetchYesterdayResults, updateScheduleContext, fetchInjuryReports } = require('./data-collection');
const { generateMLBPredictions, generateNBAPredictions, generateNHLPredictions, generateNFLPredictions, takeCLVSnapshot, gradePerformanceLog } = require('./predictions');
const { sendDailyPicksEmail, sendPerformanceSummary, sendTriggerHealthCheck, sendPropAlertEmail } = require('./emails');
const { updatePlayerProps, generatePropEdges, gradePropPicks } = require('./props');
const { updatePlayerTiers } = require('./player-tiers');
const { updatePlayerStatus } = require('./prop-status');
const { snapPropLines, snapClosingPropLines, gradePropEdges, updateAllPropWeights } = require('./prop-clv');
const { runAllOptimizations, syncPerformanceLog, seedPropWeights, seedModifiers } = require('./optimize');
const { withMonitoring, trimAccumulatingSheets } = require('./monitoring');
const { replayBacktest, sensitivityAnalysis, validateCurrentWeights, counterfactualBacktest } = require('./backtesting');
const { snapshotTeamStats, snapshotOdds, snapshotInjuries } = require('./snapshots');
const { updateAllPlayerRankings } = require('./player-rankings');

/** Small delay to spread Sheets writes across the quota window. */
const pause = (ms) => new Promise(r => setTimeout(r, ms));

// Roll last_seen_* on open v2 tickets from the snapshot that was just written.
// Isolated in try/catch: the odds pipeline must never fail because CLV tracking
// hit a problem. A silent no-op would be worse than a loud one, so log both.
async function rollAfterOdds(label) {
  try {
    const clv = require('./clv');
    const rolled = await clv.rollLastSeen();
    console.log(`[${label}] CLV roll: ${rolled.updated || 0}/${rolled.open || 0} open tickets updated (opp-side ${rolled.withOpp || 0})${rolled.reason ? ` — ${rolled.reason}` : ''}`);
  } catch (err) {
    console.warn(`[${label}] CLV roll failed (non-fatal): ${err.message}`);
  }
}

// ── Trigger Map ──────────────────────────────────────────────────
// Maps trigger names (passed as CLI arg) to their functions.
// Each trigger corresponds to one GitHub Actions workflow file.
//
// Every trigger is wrapped in withMonitoring() so it writes a row to
// Trigger_Monitor + Simple_Monitor and refreshes the Dashboard header.

const TRIGGERS = {
  // Trigger 1: 3:30 AM ET → Update player stats from ESPN
  trigger1: withMonitoring('trigger1', updatePlayerStats),

  // Trigger 2: 4:00 AM ET → Update team stats + schedule context from ESPN
  trigger2: withMonitoring('trigger2', async () => {
    await updateTeamStats();
    await updateScheduleContext();
    await fetchInjuryReports(); // ESPN injury reports for all 4 leagues
    await snapshotTeamStats(); // daily state snapshot for historical accuracy
  }),

  // Trigger 3: 4:30 AM ET → Fetch odds, grade yesterday, CLV snapshot
  // 2026-08-02: rollLastSeen() used to run ONLY inside the hourly freeze job.
  // But the odds snapshots it reads are captured by trigger3 (06:30), trigger10
  // (17:00) and trigger11 (23:00) UTC — and GitHub delivers the "hourly" freeze
  // cron every 2-4h in practice. So a 23:00 snapshot, the one taken closest to a
  // 23:05 first pitch, was usually never rolled before the ticket froze: the
  // close fell back to the 17:00 prices and close_lag_hours ran ~5h. Rolling
  // immediately after each fetch is free (no API call — it reads the snapshot
  // just written) and is what §2 means by "jobs A and B share one response".
  // Never throw from here: a roll failure must not fail the odds pipeline.
  trigger3: withMonitoring('trigger3', async () => {
    await fetchOddsAndGrade();
    await takeCLVSnapshot();
    await snapshotOdds(); // daily odds snapshot for historical accuracy
    await rollAfterOdds('trigger3');
  }),

  // Trigger 4: 5:00 AM ET → All sport predictions (MLB, NBA, NHL, NFL)
  trigger4: withMonitoring('trigger4', async () => {
    await generateMLBPredictions();
    await generateNBAPredictions();
    await generateNHLPredictions();
    await generateNFLPredictions();
  }),

  // CLV freeze: hourly. Roll last_seen from the freshest odds snapshot, freeze
  // any open v2 ticket whose game has started (close_* := last_seen_*, compute
  // CLV), then grade any closed ticket whose game has finished (ESPN by
  // game_date). No Odds API cost — reads snapshot + free ESPN scoreboard.
  freeze: withMonitoring('freeze', async () => {
    const clv = require('./clv');
    const rolled = await clv.rollLastSeen();
    const frozen = await clv.freezeClosedTickets();
    const graded = await clv.gradeClosedTickets();
    console.log(`[freeze] rolled ${rolled.updated || 0} (opp-side ${rolled.withOpp || 0}); froze ${frozen.frozen || 0} (no-vig ${frozen.novig || 0}); graded ${graded.graded || 0}${graded.unmatched ? `, unmatched ${graded.unmatched}` : ''}`);
  }),

  // Trigger 4b: 6:00 AM PT → MLB-only re-check. Catches doubleheader nightcaps
  // (and any other MLB games) whose odds weren't posted during the overnight
  // run. Idempotent: generateMLBPredictions only inserts games not already
  // logged today — keyed by matchup + market + start_time — so it never
  // re-adds the morning's games, only the newly-available ones.
  trigger4b: withMonitoring('trigger4b', async () => {
    await generateMLBPredictions();
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
    await snapshotInjuries();     // daily injury snapshot for historical accuracy
    await updatePlayerProps();
  }),

  // Trigger 7: 6:15 AM ET → Compute prop edges + snapshot opening lines for CLV
  trigger7: withMonitoring('trigger7', async () => {
    await generatePropEdges();
    await snapPropLines();  // archive opening edges for CLV comparison tonight
    await sendPropAlertEmail();  // email top prop picks (edge >= 5%)
  }),

  // Trigger 8: 6:20 AM ET → Player tiers
  trigger8: withMonitoring('trigger8', updatePlayerTiers),

  // Trigger 9: 6:30 AM ET → Send daily picks email
  trigger9: withMonitoring('trigger9', sendDailyPicksEmail),

  // Trigger 10: 12:00 PM ET → Midday odds refresh + props re-fetch
  // Most books haven't posted NBA/NHL player props by the 6 AM fetch.
  // This midday cycle catches late-posted lines without touching the
  // CLV opening snapshot (morning baseline stays intact for grading).
  //
  // Pauses between major steps to stay under the 60 writes/min Sheets quota.
  // With buffered API logging this is mostly belt-and-suspenders.
  trigger10: withMonitoring('trigger10', async () => {
    await fetchOddsAndGrade();
    await pause(5000);
    await updatePlayerStatus();
    await pause(3000);
    await updatePlayerProps();
    await pause(5000);
    await generatePropEdges();
    await rollAfterOdds('trigger10');
  }),

  // Trigger 19: 21:45 UTC → Pre-close odds pull, purely to tighten CLV.
  //
  // The other odds pulls land at 06:30, 17:00 and 23:00 UTC. The MLB slate
  // mostly starts 22:40-23:20 UTC, so the last useful pull for most games was
  // 17:00 — a ~5.7h gap — and the 23:00 pull arrives after the early games have
  // already started (they're then excluded by commenceTimeFrom=now, so it can't
  // help them). Measured close_lag_hours was 5.09h before roll-after-fetch and
  // still 3.90h after; the remaining gap is cadence, not code.
  //
  // 21:45 rather than 22:00 deliberately: GitHub delivers scheduled crons late
  // and unpredictably, so this buys ~55min of slack before first pitch. If it
  // does drift past a game's start, that game simply drops out of the snapshot
  // and keeps its earlier close — degraded, never wrong.
  //
  // Deliberately lean: odds + roll only. No props, no stats, no prop-edge
  // generation. Its whole job is to put a fresh price on open tickets shortly
  // before they lock, and every extra step is another way for it to fail.
  trigger19: withMonitoring('trigger19', async () => {
    await fetchOddsAndGrade();
    await rollAfterOdds('trigger19');
  }),

  // Trigger 11: 6:00 PM ET → Evening odds refresh + CLV + cache closing prop lines
  trigger11: withMonitoring('trigger11', async () => {
    await fetchOddsAndGrade();
    await takeCLVSnapshot();
    await snapClosingPropLines();  // cache prop lines before events expire from Odds API
    // This is the pull closest to first pitch for the evening slate, so this
    // roll is the one that actually determines close quality.
    await rollAfterOdds('trigger11');
  }),

  // Trigger 12: 11:00 PM ET → Fetch yesterday's scores + grade bets + grade props + grade prop CLV
  trigger12: withMonitoring('trigger12', async () => {
    await fetchYesterdayResults();
    await gradePerformanceLog();
    await gradePropPicks();   // grade prop W/L against ESPN box scores
    await gradePropEdges();   // compare opening vs closing prop lines for CLV grading
  }),

  // Trigger 13: Sunday 8:00 PM ET → Weekly performance summary
  trigger13: withMonitoring('trigger13', sendPerformanceSummary),

  // Trigger 14: 11:30 PM ET → Full nightly optimization cycle
  // Syncs Performance Log to Supabase, auto-updates modifiers,
  // applies CLV penalties, updates prop weights.
  trigger14: withMonitoring('trigger14', async () => {
    await trimAccumulatingSheets();
    await runAllOptimizations();
  }),

  // Trigger 15: One-time bootstrap — sync historical data + seed weights + modifiers
  // Run manually via workflow_dispatch after Supabase setup.
  trigger15: withMonitoring('trigger15', async () => {
    await syncPerformanceLog();
    await seedPropWeights();
    await seedModifiers();  // populate performance_modifiers table for dynamic loading
  }),

  // Trigger 16: Midnight ET → Daily health check email
  // Compares today's Trigger_Monitor entries against expected schedule.
  // Alerts if any triggers failed or never ran.
  trigger16: withMonitoring('trigger16', sendTriggerHealthCheck),

  // Backtest: manual dispatch — runs sensitivity analysis + weight validation
  backtest: withMonitoring('backtest', async () => {
    const sensitivity = await sensitivityAnalysis({ days: 30, delta: 0.10 });
    const validation = await validateCurrentWeights(30);
    console.log('[backtest] Sensitivity:', sensitivity.length, 'segments analyzed');
    console.log('[backtest] Validation:', validation.valid ? 'PASS' : `FAIL — ${validation.misaligned.length} misaligned`);
  }),

  // Counterfactual backtest: re-runs full game model with historical snapshots
  backtest_counterfactual: withMonitoring('backtest_counterfactual', async () => {
    const days = parseInt(process.env.BACKTEST_DAYS || '60');
    // Parse weight mods from env var (JSON array) if provided
    let mods = [];
    if (process.env.BACKTEST_MODS) {
      try { mods = JSON.parse(process.env.BACKTEST_MODS); }
      catch (e) { console.warn('[backtest-cf] Could not parse BACKTEST_MODS:', e.message); }
    }
    const result = await counterfactualBacktest(mods, { days });
    if (result) {
      console.log('[backtest-cf] Complete:', JSON.stringify(result.diff));
    }
  }),

  // Trigger 17: Manual sheet capacity cleanup
  trigger17: withMonitoring('trigger17', trimAccumulatingSheets),

  // Trigger 18: Tuesday 3:00 AM PT — Weekly player rankings refresh
  // Fetches individual player stats from ESPN, computes z-score composite
  // rankings per position group, writes to separate Player Stats spreadsheet.
  trigger18: withMonitoring('trigger18', updateAllPlayerRankings),
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
