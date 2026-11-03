'use strict';
/**
 * src/injury-replacement.js — injury impact = the player out minus the player in.
 *
 * 2026-11-03 (Nick): an absence matters by how much worse the replacement is.
 * A star with a weak backup is a big swing; a role-player starter whose backup
 * is nearly as good barely matters; a bench player out matters not at all.
 *
 * Pure function, no I/O. Shared by the model (src/injury-impact.js) and the
 * app's Rankings tab (copied in by web/scripts/copy-params.mjs).
 *
 * Input players: { name, team, pos, score (0-100 rating), status } for one
 * league. Output: per-player replacement + impact, and a per-team total.
 */

// Position → depth-chart bucket, and how many starters each bucket has.
const BUCKETS = {
  NBA: {
    map: { PG: 'G', SG: 'G', G: 'G', SF: 'F', PF: 'F', F: 'F', 'G-F': 'F', 'F-G': 'G', C: 'C', 'F-C': 'C', 'C-F': 'C' },
    starters: { G: 2, F: 2, C: 1 },
    // Basketball is close to positionless: with no backup centre listed, the
    // best healthy bench player of any position fills in.
    anyPositionBackup: true,
  },
  NFL: {
    map: {
      QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
      DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
      CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DB: 'DB',
    },
    starters: { QB: 1, RB: 1, WR: 3, TE: 1, DL: 4, LB: 2, DB: 4 },
  },
  NHL: {
    map: { G: 'G', D: 'D', C: 'F', LW: 'F', RW: 'F', F: 'F' },
    starters: { G: 1, F: 12, D: 6 },
  },
  MLB: {
    // Starting pitchers are handled per game by the pitcher model, not here.
    map: { C: 'C', '1B': 'IF', '2B': 'IF', '3B': 'IF', SS: 'IF', IF: 'IF', LF: 'OF', CF: 'OF', RF: 'OF', OF: 'OF', DH: 'DH' },
    starters: { C: 1, IF: 4, OF: 3, DH: 1 },
  },
};

// How likely the player is to miss the game. Same scale as injury-impact.js.
const STATUS_MISS = {
  out: 1.0, o: 1.0, scratched: 1.0, suspended: 1.0, suspension: 1.0,
  doubtful: 0.75, d: 0.75, questionable: 0.40, q: 0.40,
  'day-to-day': 0.30, dtd: 0.30, probable: 0.10, p: 0.10,
};
// Out for weeks: already reflected in team stats and in who is starting now,
// so these players are simply not on the depth chart and cost nothing.
const LONG_TERM = new Set(['injured reserve', 'ir', '60-day-il', '10-day-il', '15-day-il', 'suspension', 'suspended', 'out for season', 'pup', 'nfi']);

const REPLACEMENT_LEVEL = 30; // rating assumed when nobody healthy is left
const MAX_PER_PLAYER = 0.6;   // one absence can never be worth more than this

function normStatus(s) { return String(s || '').trim().toLowerCase(); }
function missChance(status) {
  const s = normStatus(status);
  if (!s || s === 'active' || s === 'healthy' || s === 'available') return 0;
  return STATUS_MISS[s] ?? 0.5;
}
function isLongTerm(status) { return LONG_TERM.has(normStatus(status)); }

/**
 * @param {string} league  NBA | NFL | NHL | MLB
 * @param {Array<{name,team,pos,score,status}>} players
 * @returns {{ players: Array, teams: Object<string, number> }}
 *   players: input rows plus { bucket, starter, replacement, replacementScore, impact }
 *   teams:   team abbr → total impact, capped at 1.0
 */
function computeReplacementImpact(league, players) {
  const cfg = BUCKETS[league];
  const out = players.map(p => ({ ...p, bucket: null, starter: false, replacement: null, replacementScore: null, impact: 0 }));
  const teams = {};
  if (!cfg) return { players: out, teams };

  // Group into team + bucket depth charts, best first. Long-term absentees
  // are left off — whoever replaced them is already the starter.
  const charts = {};
  for (const p of out) {
    p.bucket = cfg.map[String(p.pos || '').toUpperCase()] || null;
    if (!p.bucket || !p.team || !Number.isFinite(p.score) || isLongTerm(p.status)) continue;
    (charts[`${p.team}|${p.bucket}`] = charts[`${p.team}|${p.bucket}`] || []).push(p);
  }

  const used = new Set(); // bench players already filling in for someone
  for (const chart of Object.values(charts)) {
    const bucket = chart[0].bucket;
    chart.sort((a, b) => b.score - a.score);
    chart.slice(0, cfg.starters[bucket] || 1).forEach(p => { p.starter = true; });
  }
  const teamBench = (team) => out
    .filter(p => p.team === team && p.bucket && !p.starter && !isLongTerm(p.status) && missChance(p.status) < 1 && !used.has(p))
    .sort((a, b) => b.score - a.score);

  for (const [key, chart] of Object.entries(charts)) {
    const [team, bucket] = key.split('|');
    const nStart = cfg.starters[bucket] || 1;

    // Bench players who will actually play, best first. Each one can fill
    // in for only one missing starter.
    const bench = chart.slice(nStart).filter(p => missChance(p.status) < 1);
    for (const p of chart.slice(0, nStart)) {
      const miss = missChance(p.status);
      if (miss === 0) continue;
      let sub = bench.find(b => !used.has(b));
      if (!sub && cfg.anyPositionBackup) sub = teamBench(team)[0];
      if (sub) used.add(sub);
      p.replacement = sub ? sub.name : null;
      p.replacementScore = sub ? sub.score : REPLACEMENT_LEVEL;
      const gap = Math.max(0, p.score - p.replacementScore) / 100;
      p.impact = Math.min(MAX_PER_PLAYER, gap) * miss;
      teams[team] = Math.min(1, (teams[team] || 0) + p.impact);
    }
  }
  return { players: out, teams };
}

module.exports = { computeReplacementImpact, BUCKETS, missChance, isLongTerm, REPLACEMENT_LEVEL };
