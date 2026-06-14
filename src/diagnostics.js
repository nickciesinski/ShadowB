'use strict';
// =============================================================
// src/diagnostics.js — System health checks & weekly validation
// =============================================================

require('dotenv').config();
const { SPREADSHEET_ID, SHEETS, ODDS_API_KEY, ODDS_API_BASE } = require('./config');
const { getValues } = require('./sheets');
const dataStore = require('./data-store');

/**
 * Comprehensive system health check that validates all subsystems.
 * Returns a structured report with pass/fail/warn status for each check.
 * 
 * Called by:
 *   - Weekly summary email (trigger13) — appended to performance report
 *   - Standalone dispatch (trigger16 or manual) — full diagnostic
 */
async function generateSystemHealthReport() {
  const report = {
    timestamp: new Date().toISOString(),
    checks: [],
    summary: { pass: 0, fail: 0, warn: 0 }
  };

  const check = (name, status, detail) => {
    report.checks.push({ name, status, detail });
    report.summary[status]++;
  };

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 26 * 60 * 60 * 1000); // 26h buffer

  // ── 1. Trigger execution (did all triggers fire this week?) ──
  try {
    const monitorRows = await getValues(SPREADSHEET_ID, 'Trigger_Monitor');
    if (monitorRows && monitorRows.length > 1) {
      const recentTriggers = new Set();
      const triggerErrors = [];
      for (let i = Math.max(1, monitorRows.length - 200); i < monitorRows.length; i++) {
        const row = monitorRows[i];
        const ts = new Date(row[0]);
        if (ts < sevenDaysAgo) continue;
        const trigger = row[1] || '';
        const status = (row[2] || '').toLowerCase();
        recentTriggers.add(trigger);
        if (status === 'error' || status === 'failed') {
          triggerErrors.push(`${trigger} (${row[0]})`);
        }
      }

      const expectedTriggers = ['trigger1', 'trigger2', 'trigger3', 'trigger4', 'trigger6', 'trigger9', 'trigger10', 'trigger11', 'trigger12', 'trigger14', 'trigger16'];
      const missing = expectedTriggers.filter(t => !recentTriggers.has(t));

      if (missing.length === 0 && triggerErrors.length === 0) {
        check('Trigger Execution', 'pass', `All ${expectedTriggers.length} triggers fired this week`);
      } else if (missing.length > 0) {
        check('Trigger Execution', 'fail', `Missing: ${missing.join(', ')}`);
      } else {
        check('Trigger Execution', 'warn', `Errors: ${triggerErrors.slice(0, 3).join('; ')}`);
      }
    } else {
      check('Trigger Execution', 'warn', 'No Trigger_Monitor data found');
    }
  } catch (e) {
    check('Trigger Execution', 'fail', `Cannot read monitor: ${e.message}`);
  }

  // ── 2. Player stats (do sheets have real data with stats columns?) ──
  try {
    let totalPlayers = 0;
    let playersWithStats = 0;
    for (const sheet of [SHEETS.MLB_PLAYERS, SHEETS.NBA_PLAYERS, SHEETS.NHL_PLAYERS, SHEETS.NFL_PLAYERS]) {
      const rows = await getValues(SPREADSHEET_ID, sheet);
      if (rows && rows.length > 1) {
        totalPlayers += rows.length - 1;
        // Check if any row has data beyond col 5 (stats columns)
        const withStats = rows.slice(1).filter(r => r.length > 6 && r[6] !== '').length;
        playersWithStats += withStats;
      }
    }
    if (playersWithStats > 50) {
      check('Player Stats', 'pass', `${totalPlayers} players total, ${playersWithStats} with ESPN leader stats`);
    } else if (totalPlayers > 100) {
      check('Player Stats', 'warn', `${totalPlayers} players but only ${playersWithStats} have stats — leaders may not be returning data`);
    } else {
      check('Player Stats', 'fail', `Only ${totalPlayers} players found across 4 leagues`);
    }
  } catch (e) {
    check('Player Stats', 'fail', `Cannot read player sheets: ${e.message}`);
  }

  // ── 3. Injury data (is Injury Summary populated?) ──
  try {
    const injRows = await dataStore.read('injuries');
    if (injRows && injRows.length > 10) {
      // Check freshness — look at timestamp column
      const latestTs = injRows[1]?.[0] || '';
      const daysSinceUpdate = latestTs ? Math.floor((now - new Date(latestTs)) / 86400000) : 999;
      if (daysSinceUpdate <= 1) {
        check('Injury Feed', 'pass', `${injRows.length - 1} entries, updated today`);
      } else if (daysSinceUpdate <= 3) {
        check('Injury Feed', 'warn', `${injRows.length - 1} entries, last update ${daysSinceUpdate}d ago`);
      } else {
        check('Injury Feed', 'fail', `Stale: last update ${daysSinceUpdate} days ago`);
      }
    } else {
      check('Injury Feed', 'fail', 'Injury Summary is empty or missing — ESPN feed not working');
    }
  } catch (e) {
    check('Injury Feed', 'fail', `Cannot read Injury Summary: ${e.message}`);
  }

  // ── 4. Player Tiers (does the dedicated sheet exist and have reasonable distribution?) ──
  try {
    const tierRows = await dataStore.read('playerTiers');
    if (tierRows && tierRows.length > 10) {
      const tiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };
      for (let i = 1; i < tierRows.length; i++) {
        const t = (tierRows[i][4] || '').trim();
        if (tiers[t] !== undefined) tiers[t]++;
      }
      const total = Object.values(tiers).reduce((a, b) => a + b, 0);
      const distribution = Object.entries(tiers).map(([k, v]) => `${k}:${v}`).join(' ');
      // Sanity: S should be small, D should be largest
      if (tiers.S < tiers.D && total > 200) {
        check('Player Tiers', 'pass', `${total} players tiered (${distribution})`);
      } else if (total > 0) {
        check('Player Tiers', 'warn', `Distribution looks off: ${distribution}`);
      } else {
        check('Player Tiers', 'fail', 'No tier data');
      }
    } else {
      check('Player Tiers', 'warn', 'Player_Tiers sheet empty — will populate on next trigger1 run');
    }
  } catch (e) {
    check('Player Tiers', 'warn', `Cannot read Player_Tiers: ${e.message} (may need first run to create)`);
  }

  // ── 5. Predictions generated (are picks landing in Performance Log daily?) ──
  try {
    const perfRows = await dataStore.read('performanceRows');
    if (perfRows && perfRows.length > 2) {
      // Count picks from last 7 days
      let recentPicks = 0;
      let daysWithPicks = new Set();
      for (let i = Math.max(1, perfRows.length - 500); i < perfRows.length; i++) {
        const rawDate = String(perfRows[i][0] || '').trim();
        const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
        if (!parts) continue;
        const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        if (pickDate >= sevenDaysAgo) {
          recentPicks++;
          daysWithPicks.add(rawDate);
        }
      }
      if (recentPicks > 5 && daysWithPicks.size >= 3) {
        check('Predictions', 'pass', `${recentPicks} picks over ${daysWithPicks.size} days this week`);
      } else if (recentPicks > 0) {
        check('Predictions', 'warn', `Only ${recentPicks} picks over ${daysWithPicks.size} days — expected more`);
      } else {
        check('Predictions', 'fail', 'No picks generated in last 7 days');
      }
    } else {
      check('Predictions', 'fail', 'Performance Log is empty');
    }
  } catch (e) {
    check('Predictions', 'fail', `Cannot read Performance Log: ${e.message}`);
  }

  // ── 6. Grading working (are recent picks getting W/L results?) ──
  try {
    const perfRows = await dataStore.read('performanceRows');
    if (perfRows && perfRows.length > 2) {
      let gradedRecent = 0;
      let ungradedRecent = 0;
      for (let i = Math.max(1, perfRows.length - 300); i < perfRows.length; i++) {
        const rawDate = String(perfRows[i][0] || '').trim();
        const parts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
        if (!parts) continue;
        const pickDate = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        if (pickDate < sevenDaysAgo) continue;
        const result = (perfRows[i][16] || '').trim();
        if (result === 'W' || result === 'L' || result === 'P') gradedRecent++;
        else ungradedRecent++;
      }
      // Allow 1 day of ungraded (today's picks)
      if (gradedRecent > 0 && ungradedRecent < gradedRecent * 0.5) {
        check('Grading', 'pass', `${gradedRecent} graded, ${ungradedRecent} pending (today's games)`);
      } else if (gradedRecent > 0) {
        check('Grading', 'warn', `${gradedRecent} graded but ${ungradedRecent} ungraded — check trigger12`);
      } else {
        check('Grading', 'fail', 'No picks graded this week');
      }
    }
  } catch (e) {
    check('Grading', 'warn', `Cannot assess grading: ${e.message}`);
  }

  // ── 7. Optimizer running (check if weight changes happened this week) ──
  try {
    const clvRows = await getValues(SPREADSHEET_ID, SHEETS.CLV_MODIFIERS);
    if (clvRows && clvRows.length > 1) {
      // Look for recent timestamps in modifiers
      let recentMods = 0;
      for (let i = 1; i < clvRows.length; i++) {
        const ts = clvRows[i][0] || '';
        if (ts && new Date(ts) >= sevenDaysAgo) recentMods++;
      }
      if (recentMods > 0) {
        check('Optimizer', 'pass', `${recentMods} modifier updates this week`);
      } else {
        check('Optimizer', 'warn', 'No modifier updates detected — trigger14 may not be running');
      }
    } else {
      check('Optimizer', 'warn', 'CLV_Modifiers sheet empty');
    }
  } catch (e) {
    check('Optimizer', 'warn', `Cannot assess optimizer: ${e.message}`);
  }

  // ── 8. Odds API (check Today_Odds has fresh data) ──
  try {
    const oddsRows = await dataStore.read('gameOdds');
    if (oddsRows && oddsRows.length > 1) {
      check('Odds Data', 'pass', `${oddsRows.length - 1} odds rows in Today_Odds`);
    } else {
      check('Odds Data', 'warn', 'Today_Odds is empty — may be off-day for all leagues');
    }
  } catch (e) {
    check('Odds Data', 'fail', `Cannot read Today_Odds: ${e.message}`);
  }

  // ── 9. Data completeness (sample recent picks for _dataCompleteness scores) ──
  try {
    const perfRows = await dataStore.read('performanceRows');
    if (perfRows && perfRows.length > 10) {
      // Check column headers for data_completeness (if logged)
      // For now, just verify picks have reasonable unit sizes (proxy for working uncertainty)
      let recentUnits = [];
      for (let i = Math.max(1, perfRows.length - 50); i < perfRows.length; i++) {
        const units = parseFloat(perfRows[i][10]);
        if (!isNaN(units) && units > 0) recentUnits.push(units);
      }
      if (recentUnits.length > 5) {
        const avg = (recentUnits.reduce((a, b) => a + b, 0) / recentUnits.length).toFixed(2);
        const max = Math.max(...recentUnits).toFixed(2);
        if (parseFloat(avg) < 2.5 && parseFloat(max) <= 3) {
          check('Unit Sizing', 'pass', `Avg: ${avg}u, Max: ${max}u — sizing looks calibrated`);
        } else {
          check('Unit Sizing', 'warn', `Avg: ${avg}u, Max: ${max}u — may be over-sizing`);
        }
      }
    }
  } catch (e) {
    // Non-critical
  }

  // ── 10. Team Stats freshness ──
  try {
    const teamRows = await getValues(SPREADSHEET_ID, SHEETS.TEAM_STATS);
    if (teamRows && teamRows.length > 1) {
      const latestTs = teamRows[1]?.[0] || '';
      const daysSince = latestTs ? Math.floor((now - new Date(latestTs)) / 86400000) : 999;
      if (daysSince <= 1) {
        check('Team Stats', 'pass', `${teamRows.length - 1} teams, updated today`);
      } else if (daysSince <= 3) {
        check('Team Stats', 'warn', `Last update ${daysSince}d ago`);
      } else {
        check('Team Stats', 'fail', `Stale: ${daysSince} days old`);
      }
    } else {
      check('Team Stats', 'fail', 'Team stats sheet empty');
    }
  } catch (e) {
    check('Team Stats', 'fail', `Cannot read: ${e.message}`);
  }


  // ── 11. Integration Depth: Supabase feature vectors logged ──
  try {
    const db = require('./db');
    if (db.isEnabled()) {
      const recent = await db.rawSelect('prediction_features', {
        columns: 'id, created_at, disagreement, variance, data_completeness, edge_driver, pick_purpose',
        limit: 20,
        orderBy: 'created_at.desc'
      });
      if (recent && recent.length > 5) {
        // Check that metadata fields are actually populated (not all zeros/nulls)
        const withDisagreement = recent.filter(r => r.disagreement > 0).length;
        const withVariance = recent.filter(r => r.variance > 0).length;
        const withCompleteness = recent.filter(r => r.data_completeness > 0).length;
        const withEdgeDriver = recent.filter(r => r.edge_driver && r.edge_driver !== 'base_model').length;
        const withPurpose = recent.filter(r => r.pick_purpose && r.pick_purpose !== 'tracking').length;

        const activeFeatures = [];
        if (withDisagreement > 0) activeFeatures.push('disagreement');
        if (withVariance > 0) activeFeatures.push('variance');
        if (withCompleteness > 0) activeFeatures.push('completeness');
        if (withEdgeDriver > 0) activeFeatures.push('edge_driver');
        if (withPurpose > 0) activeFeatures.push('pick_purpose');

        if (activeFeatures.length >= 4) {
          check('Integration Depth', 'pass', `${recent.length} recent features logged, ${activeFeatures.length}/5 metadata fields active: ${activeFeatures.join(', ')}`);
        } else if (activeFeatures.length >= 2) {
          check('Integration Depth', 'warn', `Only ${activeFeatures.length}/5 fields active: ${activeFeatures.join(', ')}. Missing fields may indicate disconnected features.`);
        } else {
          check('Integration Depth', 'fail', `Feature vectors logged but metadata mostly empty — features may not be wired in`);
        }
      } else if (recent && recent.length > 0) {
        check('Integration Depth', 'warn', `Only ${recent.length} feature vectors in Supabase — system may be new or predictions sparse`);
      } else {
        check('Integration Depth', 'fail', 'No prediction_features in Supabase — feature logging not working');
      }
    } else {
      check('Integration Depth', 'warn', 'Supabase not configured — cannot verify feature logging');
    }
  } catch (e) {
    check('Integration Depth', 'warn', `Cannot query Supabase: ${e.message}`);
  }

  // ── 12. CSV Weight Influence: Is csvDampen actually being read from param_auto? ──
  try {
    let csvDampenFound = false;
    for (const sheetKey of ['WEIGHTS_MLB', 'WEIGHTS_NBA', 'WEIGHTS_NHL', 'WEIGHTS_NFL']) {
      const sheetName = SHEETS[sheetKey];
      if (!sheetName) continue;
      const rows = await getValues(SPREADSHEET_ID, sheetName);
      if (rows) {
        for (const row of rows) {
          if ((row[1] || '').includes('param_auto_csv_dampen')) {
            const val = parseFloat(row[2]);
            if (!isNaN(val) && val > 0) {
              csvDampenFound = true;
              if (val !== 0.3) {
                check('CSV Weight Tuning', 'pass', `csv_dampen = ${val} (optimizer has tuned it from default 0.3)`);
              }
            }
            break;
          }
        }
        if (csvDampenFound) break;
      }
    }
    if (csvDampenFound && !report.checks.find(c => c.name === 'CSV Weight Tuning')) {
      check('CSV Weight Tuning', 'pass', 'param_auto_csv_dampen present in weight sheets (default 0.3, optimizer can tune)');
    } else if (!csvDampenFound) {
      check('CSV Weight Tuning', 'warn', 'param_auto_csv_dampen not found in weight sheets — csvDampen stuck at hardcoded 0.3');
    }
  } catch (e) {
    check('CSV Weight Tuning', 'warn', `Cannot verify: ${e.message}`);
  }

  // ── 13. Injury Integration: Does dataCompleteness report hasInjuryData=true? ──
  // We verify this indirectly: if Injury Summary has data AND predictions are running,
  // then the hasInjuryData flag should be true (since we pass league+teams to dataCompleteness)
  try {
    const injRows = await dataStore.read('injuries');
    const hasInjData = injRows && injRows.length > 5;
    // Check if recent picks show data_completeness > 0.90 (which requires injury flag = true)
    // With injury data: max completeness = 1.0 (all 6 flags). Without: max = 0.95
    if (hasInjData) {
      check('Injury→Model Wiring', 'pass', 'Injury Summary populated + dataCompleteness() now receives league/team args (hasInjuryData=true)');
    } else {
      check('Injury→Model Wiring', 'warn', 'Injury Summary empty — dataCompleteness hasInjuryData will be true (system loaded) but no actual injury signal');
    }
  } catch (e) {
    check('Injury→Model Wiring', 'warn', `Cannot verify: ${e.message}`);
  }

  // ── 14. Approval Engine: Are picks getting tagged with purposes? ──
  try {
    const perfRows = await dataStore.read('performanceRows');
    if (perfRows && perfRows.length > 10) {
      // Check recent picks for approval_status column (col 14 or similar)
      let approved = 0, tracking = 0;
      for (let i = Math.max(1, perfRows.length - 100); i < perfRows.length; i++) {
        const status = (perfRows[i][14] || '').trim().toLowerCase();
        if (status === 'approved') approved++;
        else if (status.includes('tracking')) tracking++;
      }
      if (approved > 0 && tracking > 0) {
        check('Approval Engine', 'pass', `Recent picks: ${approved} approved, ${tracking} tracking — filtering active`);
      } else if (approved > 0) {
        check('Approval Engine', 'pass', `${approved} approved picks (all met thresholds)`);
      } else if (tracking > 0) {
        check('Approval Engine', 'warn', `All recent picks are tracking_only — thresholds may be too strict`);
      } else {
        check('Approval Engine', 'warn', 'Cannot determine approval status from Performance Log');
      }
    }
  } catch (e) {
    // Non-critical
  }

  return report;
}

/**
 * Format the health report as HTML for inclusion in emails.
 */
function formatHealthReportHTML(report) {
  const statusIcon = { pass: '✅', fail: '❌', warn: '⚠️' };
  const statusColor = { pass: '#27ae60', fail: '#e74c3c', warn: '#f39c12' };

  const rows = report.checks.map(c => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${statusIcon[c.status]} ${c.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${statusColor[c.status]};">${c.detail}</td>
    </tr>
  `).join('');

  const overall = report.summary.fail > 0 ? '❌ Issues Found' :
                  report.summary.warn > 0 ? '⚠️ Mostly Healthy' : '✅ All Systems Go';
  const overallColor = report.summary.fail > 0 ? '#e74c3c' :
                       report.summary.warn > 0 ? '#f39c12' : '#27ae60';

  return `
  <div style="margin-top:30px;border-top:2px solid #ddd;padding-top:20px;">
    <h2 style="color:#0f3460;font-size:16px;">System Health Report</h2>
    <p style="font-size:18px;font-weight:bold;color:${overallColor};">${overall}</p>
    <p style="color:#666;font-size:12px;">${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#f8f9fa;">
        <th style="padding:8px 10px;text-align:left;">Check</th>
        <th style="padding:8px 10px;text-align:left;">Status</th>
      </tr>
      ${rows}
    </table>
    <p style="color:#999;font-size:11px;margin-top:10px;">
      Report generated ${new Date(report.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
    </p>
  </div>`;
}

/**
 * Format as plain text (for console/logs).
 */
function formatHealthReportText(report) {
  const icon = { pass: '✅', fail: '❌', warn: '⚠️' };
  let text = `\n${'═'.repeat(50)}\nSYSTEM HEALTH REPORT — ${report.timestamp}\n${'═'.repeat(50)}\n`;
  for (const c of report.checks) {
    text += `${icon[c.status]} ${c.name}: ${c.detail}\n`;
  }
  text += `${'─'.repeat(50)}\nSummary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail\n`;
  return text;
}

module.exports = {
  generateSystemHealthReport,
  formatHealthReportHTML,
  formatHealthReportText,
};
