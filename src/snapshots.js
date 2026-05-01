'use strict';
/**
 * src/snapshots.js — Daily state snapshots for historical accuracy
 *
 * Saves daily snapshots of team stats, odds, and injury state to Supabase.
 * This enables accurate backtesting by preserving data at pick time.
 *
 * Actual Supabase table schemas (created by user):
 *
 * daily_team_stats:
 *   id (int8), date (date), league (text), team (text),
 *   stats (jsonb), created_at (timestamp)
 *
 * daily_odds:
 *   id (int8), date (date), league (text), game_id (text),
 *   home_team (text), away_team (text), market (text),
 *   odds (jsonb), created_at (timestamp)
 *
 * daily_injuries:
 *   id (int8), date (date), league (text), team (text),
 *   player (text), status (text), impact (numeric),
 *   created_at (timestamp)
 */
const db = require('./db');
const { getValues } = require('./sheets');
const { SPREADSHEET_ID, SHEETS } = require('./config');

/**
 * Snapshot today's team stats from Sheets → Supabase.
 * Called by trigger2 after updateTeamStats() writes fresh data.
 */
async function snapshotTeamStats() {
  if (!db.isEnabled()) {
    console.log('[snapshots] Supabase not configured — skipping team stats snapshot');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const sb = db.getClient();
  if (!sb) return;

  // Check if we already snapshotted today (idempotent)
  const { data: existing } = await sb
    .from('daily_team_stats')
    .select('id')
    .eq('date', today)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log('[snapshots] Team stats already snapshotted for today');
    return;
  }

  const leagueSheets = [
    { league: 'NBA', sheet: SHEETS.NBA_TEAM_STATS },
    { league: 'MLB', sheet: SHEETS.MLB_TEAM_STATS },
    { league: 'NFL', sheet: SHEETS.NFL_TEAM_STATS },
    { league: 'NHL', sheet: SHEETS.NHL_TEAM_STATS },
  ];

  const rows = [];

  for (const { league, sheet } of leagueSheets) {
    try {
      const data = await getValues(SPREADSHEET_ID, sheet);
      if (!data || data.length < 2) continue;

      for (let i = 1; i < data.length; i++) {
        const r = data[i];
        const team = (r[2] || r[3] || '').trim();
        const abbr = (r[3] || '').trim();
        if (!team && !abbr) continue;

        // Pack all stats into a jsonb column
        const stats = {
          abbr,
          wins: parseInt(r[4]) || 0,
          losses: parseInt(r[5]) || 0,
          win_pct: parseFloat(r[6]) || 0,
          off_rating: parseFloat(r[7]) || null,
          def_rating: parseFloat(r[8]) || null,
          pace: parseFloat(r[9]) || null,
          points_for: parseFloat(r[14] || r[10]) || null,
          points_against: parseFloat(r[15] || r[11]) || null,
          recent_form_pct: parseFloat(r[16]) || null,
          last10_wins: parseInt(r[17]) || null,
          last10_losses: parseInt(r[18]) || null,
        };

        rows.push({ date: today, league, team: team || abbr, stats });
      }
    } catch (e) {
      console.warn(`[snapshots] Could not read ${league} team stats:`, e.message);
    }
  }

  if (rows.length === 0) {
    console.log('[snapshots] No team stats to snapshot');
    return;
  }

  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from('daily_team_stats')
      .insert(batch);
    if (error) {
      console.warn('[snapshots] Team stats insert error:', error.message);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`[snapshots] Snapshotted ${inserted} team stat rows for ${today}`);
}

/**
 * Snapshot today's odds from Today_Odds sheet → Supabase.
 * Called by trigger3 after fetchOddsAndGrade() writes fresh odds.
 */
async function snapshotOdds() {
  if (!db.isEnabled()) {
    console.log('[snapshots] Supabase not configured — skipping odds snapshot');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const sb = db.getClient();
  if (!sb) return;

  const { data: existing } = await sb
    .from('daily_odds')
    .select('id')
    .eq('date', today)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log('[snapshots] Odds already snapshotted for today');
    return;
  }

  const oddsData = await getValues(SPREADSHEET_ID, SHEETS.GAME_ODDS);
  if (!oddsData || oddsData.length < 2) {
    console.log('[snapshots] No odds data to snapshot');
    return;
  }

  // Build consensus per game+market (aggregate across bookmakers)
  // Columns: 0=Timestamp, 1=Sport, 2=Home, 3=Away, 4=CommenceTime,
  //          5=Market, 6=Outcome, 7=Price, 8=Point, 9=Bookmaker
  const consensus = {}; // "league|game|market" → { outcomes: { outcome → { prices, lines } }, meta }

  for (let i = 1; i < oddsData.length; i++) {
    const r = oddsData[i];
    const league = (r[1] || '').trim();
    const home = (r[2] || '').trim();
    const away = (r[3] || '').trim();
    const commence = (r[4] || '').trim();
    const market = (r[5] || '').trim();
    const outcome = (r[6] || '').trim();
    const price = parseFloat(r[7]) || 0;
    const line = r[8] !== undefined && r[8] !== '' ? parseFloat(r[8]) : null;
    const book = (r[9] || '').trim();

    if (!league || !home || !outcome) continue;

    const gameId = `${away} @ ${home}`;
    const key = `${league}|${gameId}|${market}`;

    if (!consensus[key]) {
      consensus[key] = {
        league, gameId, home, away, commence, market,
        outcomes: {},
      };
    }
    if (!consensus[key].outcomes[outcome]) {
      consensus[key].outcomes[outcome] = { prices: [], lines: [], books: new Set() };
    }
    consensus[key].outcomes[outcome].prices.push(price);
    if (line !== null) consensus[key].outcomes[outcome].lines.push(line);
    consensus[key].outcomes[outcome].books.add(book);
  }

  const rows = [];
  for (const c of Object.values(consensus)) {
    // Pack all outcomes + consensus into jsonb
    const oddsObj = {};
    for (const [outcome, data] of Object.entries(c.outcomes)) {
      oddsObj[outcome] = {
        consensus_price: median(data.prices),
        consensus_line: data.lines.length > 0 ? median(data.lines) : null,
        book_count: data.books.size,
      };
    }

    rows.push({
      date: today,
      league: c.league,
      game_id: c.gameId,
      home_team: c.home,
      away_team: c.away,
      market: c.market,
      odds: oddsObj,
    });
  }

  if (rows.length === 0) {
    console.log('[snapshots] No consensus odds to snapshot');
    return;
  }

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from('daily_odds')
      .insert(batch);
    if (error) {
      console.warn('[snapshots] Odds insert error:', error.message);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`[snapshots] Snapshotted ${inserted} consensus odds rows for ${today}`);
}

/**
 * Snapshot today's injury state → Supabase.
 * Called by trigger6 after updatePlayerStatus() detects scratches.
 */
async function snapshotInjuries() {
  if (!db.isEnabled()) {
    console.log('[snapshots] Supabase not configured — skipping injury snapshot');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const sb = db.getClient();
  if (!sb) return;

  const { data: existing } = await sb
    .from('daily_injuries')
    .select('id')
    .eq('date', today)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log('[snapshots] Injuries already snapshotted for today');
    return;
  }

  const rows = [];

  // Source 1: Prop_Status scratches
  try {
    const statusData = await getValues(SPREADSHEET_ID, SHEETS.PROP_STATUS);
    if (statusData && statusData.length > 1) {
      for (const r of statusData.slice(1)) {
        const status = (r[4] || '').trim();
        if (status !== 'SCRATCHED') continue;
        const isKey = (r[5] || '').trim() === 'key_player';
        rows.push({
          date: today,
          league: (r[1] || '').trim(),
          team: '',
          player: (r[2] || '').trim(),
          status: 'SCRATCHED',
          impact: isKey ? 0.7 : 0.2,
        });
      }
    }
  } catch (e) {
    console.warn('[snapshots] Could not read Prop_Status:', e.message);
  }

  // Source 2: Injury Summary sheet
  try {
    const injData = await getValues(SPREADSHEET_ID, SHEETS.INJURY_SUMMARY);
    if (injData && injData.length > 1) {
      const headers = injData[0].map(h => String(h).trim().toLowerCase());
      const leagueIdx = headers.findIndex(h => h === 'league' || h === 'sport');
      const teamIdx = headers.findIndex(h => h === 'team' || h === 'team_abbr');
      const playerIdx = headers.findIndex(h => h === 'player' || h === 'name');
      const statusIdx = headers.findIndex(h => h === 'status' || h === 'injury_status');

      if (leagueIdx >= 0 && playerIdx >= 0) {
        for (let i = 1; i < injData.length; i++) {
          const r = injData[i];
          const injStatus = (r[statusIdx] || '').trim().toLowerCase();
          if (injStatus === 'active' || injStatus === 'healthy' || injStatus === 'available') continue;

          let impact = 0.1;
          if (injStatus === 'out' || injStatus === 'o') impact = 0.5;
          else if (injStatus === 'doubtful' || injStatus === 'd') impact = 0.4;
          else if (injStatus === 'questionable' || injStatus === 'q') impact = 0.2;
          else if (injStatus === 'probable' || injStatus === 'p') impact = 0.05;

          const player = (r[playerIdx] || '').trim();
          if (!player) continue;

          const league = (r[leagueIdx] || '').trim();
          const alreadyExists = rows.some(
            existing => existing.league === league && existing.player === player
          );
          if (alreadyExists) continue;

          rows.push({
            date: today,
            league,
            team: teamIdx >= 0 ? (r[teamIdx] || '').trim() : '',
            player,
            status: injStatus.toUpperCase(),
            impact,
          });
        }
      }
    }
  } catch (e) {
    console.warn('[snapshots] Could not read Injury Summary:', e.message);
  }

  if (rows.length === 0) {
    console.log('[snapshots] No injury data to snapshot');
    return;
  }

  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from('daily_injuries')
      .insert(batch);
    if (error) {
      console.warn('[snapshots] Injury insert error:', error.message);
    } else {
      inserted += batch.length;
    }
  }

  console.log(`[snapshots] Snapshotted ${inserted} injury records for ${today}`);
}

/**
 * Read historical team stats for a specific date + league.
 * Used by backtesting to evaluate past picks with the data that existed then.
 */
async function getHistoricalTeamStats(date, league) {
  if (!db.isEnabled()) return null;
  const sb = db.getClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from('daily_team_stats')
    .select('*')
    .eq('date', date)
    .eq('league', league);

  if (error || !data || data.length === 0) return null;

  const map = {};
  for (const row of data) {
    const s = row.stats || {};
    const key = s.abbr || row.team;
    map[key] = {
      wins: s.wins,
      losses: s.losses,
      pct: s.win_pct,
      offRating: s.off_rating,
      defRating: s.def_rating,
      pace: s.pace,
      pointsFor: s.points_for,
      pointsAgainst: s.points_against,
      recentFormPct: s.recent_form_pct,
    };
  }
  return map;
}

/**
 * Read historical injuries for a specific date + league.
 */
async function getHistoricalInjuries(date, league) {
  if (!db.isEnabled()) return [];
  const sb = db.getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from('daily_injuries')
    .select('*')
    .eq('date', date)
    .eq('league', league);

  if (error) return [];
  return data || [];
}

// ── Helpers ─────────────────────────────────────────────────────

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = {
  snapshotTeamStats,
  snapshotOdds,
  snapshotInjuries,
  getHistoricalTeamStats,
  getHistoricalInjuries,
};
