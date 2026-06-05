'use strict';
/**
 * src/calibration.js — Confidence calibration feedback loop
 *
 * Reads graded performance data, buckets by edge size, computes
 * actual win rates per bucket, and generates calibration multipliers.
 * These multipliers adjust unit sizing so the system bets less when
 * it's historically overconfident at a given edge level, and more
 * when it's been underconfident.
 *
 * Calibration data is cached per trigger run and consumed by
 * market-pricing.js calcUnits().
 */
const db = require('./db');
const { getValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

// ── Edge buckets (percentage) ───────────────────────────────────
// Each bucket represents a range of edge values.
// Calibration computes actual win rate per bucket.
const EDGE_BUCKETS = [
  { label: '0-1%',   min: 0,   max: 1   },
  { label: '1-2%',   min: 1,   max: 2   },
  { label: '2-3%',   min: 2,   max: 3   },
  { label: '3-4%',   min: 3,   max: 4   },
  { label: '4-5%',   min: 4,   max: 5   },
  { label: '5-7%',   min: 5,   max: 7   },
  { label: '7%+',    min: 7,   max: 100 },
];

// ── Module-level cache ──────────────────────────────────────────
let _calibrationMap = null; // { bucketLabel: multiplier }

/**
 * Load calibration multipliers from Supabase view or compute from Sheets.
 * Returns a map: { '0-1%': 0.85, '1-2%': 0.95, ... }
 * Multiplier < 1 = we've been overconfident in this bucket (size down)
 * Multiplier > 1 = we've been underconfident (size up)
 * Multiplier = 1 = well-calibrated or insufficient data
 */
async function loadCalibration() {
  if (_calibrationMap) return _calibrationMap;

  // Try Supabase view first
  let calData = null;
  if (db.isEnabled()) {
    calData = await db.getConfidenceCalibration();
  }

  if (calData && calData.length > 0) {
    _calibrationMap = {};
    for (const row of calData) {
      // View returns: confidence_bucket, sample_size, wins, win_rate, expected_win_rate
      const bucket = row.confidence_bucket || row.edge_bucket;
      if (!bucket) continue;
      const actual = parseFloat(row.win_rate) / 100;
      const expected = parseFloat(row.expected_win_rate) / 100;
      if (expected > 0 && row.sample_size >= 15) {
        // Ratio of actual/expected, clamped to [0.5, 1.5]
        // Smoothed: blend 70% toward 1.0 to prevent wild swings
        const rawRatio = actual / expected;
        const smoothed = 0.3 * rawRatio + 0.7 * 1.0;
        _calibrationMap[bucket] = Math.max(0.5, Math.min(1.5, Math.round(smoothed * 100) / 100));
      } else {
        _calibrationMap[bucket] = 1.0;
      }
    }
    console.log('[calibration] Loaded from Supabase:', JSON.stringify(_calibrationMap));
    return _calibrationMap;
  }

  // Fallback: compute from Sheets Performance Log
  _calibrationMap = await computeFromSheets();
  return _calibrationMap;
}

/**
 * Compute calibration from Sheets Performance Log directly.
 * Groups graded picks by edge bucket, computes actual win rate vs implied.
 */
async function computeFromSheets() {
  const map = {};
  for (const b of EDGE_BUCKETS) map[b.label] = 1.0;

  let rows;
  try {
    rows = await getValues(SPREADSHEET_ID, SHEETS.PERFORMANCE);
  } catch (e) {
    console.warn('[calibration] Could not read Performance Log:', e.message);
    return map;
  }

  if (!rows || rows.length < 2) return map;

  const headers = rows[0].map(h => String(h).trim().toLowerCase());

  // 2026-06-04: Layered column detection. Previous version only did
  // exact-match on 'result' / 'odds' and printed "Missing result or odds
  // columns" then returned default 1.0 multipliers. The actual Sheets
  // header row uses different strings (varies by Sheet edit history), so
  // calibration was permanently a no-op.
  //
  // Strategy:
  //  1. Try exact header match
  //  2. Try fuzzy header match (.includes), excluding CLV-related cols
  //  3. Fall back to known positional indices from the dual-write writer:
  //     col 9 = odds, col 11 = confidence, col 16 = result, col 0 = date.
  function findCol(predicate, fallbackIdx) {
    const idx = headers.findIndex(predicate);
    return idx >= 0 ? idx : fallbackIdx;
  }
  const exactResult = headers.indexOf('result');
  const exactOdds   = headers.indexOf('odds');
  const resultIdx = exactResult >= 0
    ? exactResult
    : findCol(h => h === 'result' || h.startsWith('result ') || /^w\/l/.test(h), 16);
  const oddsIdx = exactOdds >= 0
    ? exactOdds
    : findCol(h => /\bodds\b/.test(h) && !h.includes('closing') && !h.includes('opening') && !h.includes('clv'), 9);

  console.log(`[calibration] Column detection: resultIdx=${resultIdx} (exact=${exactResult}), oddsIdx=${oddsIdx} (exact=${exactOdds})`);
  if (resultIdx < 0 || oddsIdx < 0) {
    console.warn('[calibration] Still missing result or odds columns even after positional fallback — header row may be malformed');
    return map;
  }

  // We need the edge column — check for it (fuzzy)
  const edgeIdx = headers.findIndex(h => h === 'edge' || h === 'edge_pct' || h.includes('edge%') || /^edge\s/.test(h));

  // Accumulate wins/total per bucket
  const buckets = {};
  const impliedBuckets = {};
  for (const b of EDGE_BUCKETS) {
    buckets[b.label] = { wins: 0, total: 0 };
    impliedBuckets[b.label] = [];
  }

  // Use last 60 days of data for calibration
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  // 2026-06-04: also fall back to col 0 if 'date' header doesn't match
  let dateIdx = headers.indexOf('date');
  if (dateIdx < 0) dateIdx = headers.findIndex(h => h.includes('date')) >= 0 ? headers.findIndex(h => h.includes('date')) : 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const result = (r[resultIdx] || '').toString().trim().toUpperCase();
    if (result !== 'W' && result !== 'L') continue;

    // Date filter
    if (dateIdx >= 0) {
      const d = String(r[dateIdx] || '').slice(0, 10);
      if (d < cutoff.toISOString().slice(0, 10)) continue;
    }

    const odds = parseInt(r[oddsIdx]) || 0;
    if (odds === 0) continue;

    // Compute implied probability from American odds
    let implied;
    if (odds > 0) implied = 100 / (odds + 100);
    else implied = Math.abs(odds) / (Math.abs(odds) + 100);

    // If we have an edge column, use it; otherwise estimate edge from odds
    let edgePct = 0;
    if (edgeIdx >= 0 && r[edgeIdx]) {
      edgePct = Math.abs(parseFloat(r[edgeIdx])) || 0;
    } else {
      // Estimate: edge ≈ (confidence/10 - implied) * 100
      // Without edge data, use a rough proxy based on confidence.
      // 2026-06-04: also fall back to col 11 (the known confidence column).
      const confIdx = (function() {
        const ci = headers.findIndex(h => h.includes('confidence') || h.includes('conf'));
        return ci >= 0 ? ci : 11;
      })();
      if (confIdx >= 0) {
        // Handle "X%" strings as well as plain ints
        const conf = parseInt(String(r[confIdx]).replace('%', '')) || 5;
        edgePct = Math.max(0, (conf - 3) * 0.8); // rough mapping
      }
    }

    // Find bucket
    const bucket = EDGE_BUCKETS.find(b => edgePct >= b.min && edgePct < b.max);
    if (!bucket) continue;

    buckets[bucket.label].total++;
    if (result === 'W') buckets[bucket.label].wins++;
    impliedBuckets[bucket.label].push(implied);
  }

  // Compute multipliers
  for (const b of EDGE_BUCKETS) {
    const stats = buckets[b.label];
    if (stats.total < 30) { map[b.label] = 1.0; continue; }

    const actualWinRate = stats.wins / stats.total;
    const avgImplied = impliedBuckets[b.label].reduce((a, v) => a + v, 0) / impliedBuckets[b.label].length;
    // Expected win rate = implied + midpoint of edge bucket
    const midEdge = ((b.min + Math.min(b.max, 10)) / 2) / 100;
    const expectedWinRate = Math.min(0.95, avgImplied + midEdge);

    if (expectedWinRate > 0) {
      const rawRatio = actualWinRate / expectedWinRate;
      const smoothed = 0.3 * rawRatio + 0.7 * 1.0;
      map[b.label] = Math.max(0.5, Math.min(1.5, Math.round(smoothed * 100) / 100));
    }
  }

  console.log('[calibration] Computed from Sheets:', JSON.stringify(map));
  return map;
}

/**
 * Get the calibration multiplier for a given edge percentage.
 * Returns a number (0.5–1.5) that should multiply unit sizing.
 */
function getCalibrationMultiplier(edgePct) {
  if (!_calibrationMap) return 1.0;
  const bucket = EDGE_BUCKETS.find(b => edgePct >= b.min && edgePct < b.max);
  if (!bucket) return 1.0;
  return _calibrationMap[bucket.label] || 1.0;
}

/**
 * Reset cache (called between trigger runs if needed)
 */
function resetCalibration() {
  _calibrationMap = null;
}

/**
 * Write current calibration state to Calibration_Data sheet for visibility.
 */
async function syncCalibrationToSheets() {
  if (!_calibrationMap) return;

  const rows = [['Edge Bucket', 'Multiplier', 'Updated']];
  const ts = new Date().toISOString();
  for (const b of EDGE_BUCKETS) {
    rows.push([b.label, _calibrationMap[b.label] || 1.0, ts]);
  }

  try {
    const { setValues: sv } = require('./sheets');
    await sv(SPREADSHEET_ID, SHEETS.CALIBRATION_DATA, 'A1', rows);
    console.log('[calibration] Synced to Calibration_Data sheet');
  } catch (e) {
    console.warn('[calibration] Could not sync to Sheets:', e.message);
  }
}

module.exports = {
  loadCalibration,
  getCalibrationMultiplier,
  resetCalibration,
  syncCalibrationToSheets,
  EDGE_BUCKETS,
};
