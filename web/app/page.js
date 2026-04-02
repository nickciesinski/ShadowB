'use client';
import { useState, useEffect, useCallback } from 'react';

// ── Constants ───────────────────────────────────────────────────────
const SPORTS = ['All', 'NBA', 'NHL', 'MLB', 'NFL'];
const BET_TYPES = ['All', 'Spread', 'Moneyline', 'Total'];
const CONFIDENCE_FILTERS = ['All Bets', '0.2u+'];
const LEAGUE_COLORS = { NBA: '#C9082A', NHL: '#000', MLB: '#002D72', NFL: '#013369' };
const LEAGUE_BG = { NBA: '#FEF2F2', NHL: '#F3F4F6', MLB: '#EFF6FF', NFL: '#EEF2FF' };
const DATE_FILTERS = ['Today', 'Yesterday', 'Last 7 Days', 'All Time'];

const ESPN_SPORTS = {
  NBA: { key: 'basketball', league: 'nba' },
  NHL: { key: 'hockey', league: 'nhl' },
  MLB: { key: 'baseball', league: 'mlb' },
  NFL: { key: 'football', league: 'nfl' },
};

// ── Helpers ─────────────────────────────────────────────────────────
const fmt = (odds) => (odds > 0 ? `+${odds}` : `${odds}`);
const confColor = (c) => { const n = parseFloat(c) || 0; return n >= 8 ? '#059669' : n >= 6 ? '#D97706' : '#9CA3AF'; };
const confBg = (c) => { const n = parseFloat(c) || 0; return n >= 8 ? '#ECFDF5' : n >= 6 ? '#FFFBEB' : '#F3F4F6'; };

function cleanTime(period) {
  if (!period) return '';
  // Handle ISO dates (from startTime field)
  if (period.includes('T') && period.includes('-')) {
    try {
      const d = new Date(period);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) { return ''; }
  }
  // Clean ESPN shortDetail format
  let cleaned = period.replace(/ 0:00$/, '').replace(/ 0\.0$/, '');
  // Strip leading date like "4/2 - "
  cleaned = cleaned.replace(/^\d+\/\d+\s*-\s*/, '');
  return cleaned.trim();
}

function dedup(picks) {
  const seen = {};
  const result = [];
  for (const p of picks) {
    const key = `${p.away}|${p.home}|${(p.betType || p.market || '').toLowerCase()}|${p.pick}|${p.line}`;
    if (!seen[key]) {
      seen[key] = true;
      result.push(p);
    }
  }
  return result;
}

function getPickStatus(pick, game) {
  if (!game || game.status === 'pre') return 'pending';
  if (!game.awayScore && game.awayScore !== 0) return 'pending';
  const aS = game.awayScore, hS = game.homeScore;
  const bt = pick.betType?.toLowerCase() || pick.market?.toLowerCase();
  if (bt === 'moneyline') {
    const pickTeam = pick.pick;
    if (aS === hS) return 'even';
    if (pickTeam === game.home) return hS > aS ? 'winning' : 'losing';
    return aS > hS ? 'winning' : 'losing';
  }
  if (bt === 'spread') {
    const line = parseFloat(pick.line) || 0;
    const isHome = pick.pick?.includes(game.home);
    const margin = isHome ? (hS + line) - aS : (aS + line) - hS;
    return margin > 0 ? 'winning' : margin < 0 ? 'losing' : 'even';
  }
  if (bt === 'total') {
    const total = aS + hS;
    const line = parseFloat(pick.line) || 0;
    const isOver = pick.pick?.toLowerCase().includes('over');
    if (isOver) return total > line ? 'winning' : total < line ? 'losing' : 'even';
    return total < line ? 'winning' : total > line ? 'losing' : 'even';
  }
  return 'pending';
}

function getTrend(picks, game) {
  if (!picks.length || !game || game.status === 'pre') return null;
  let score = 0;
  for (const p of picks) {
    const s = getPickStatus(p, game);
    score += s === 'winning' ? 1 : s === 'losing' ? -1 : 0;
  }
  return score / picks.length;
}

function sortGames(games) {
  const stateOrder = { in: 0, post: 2, pre: 3 };
  return [...games].sort((a, b) => {
    const aClose = a.status === 'in' && a.isLate && Math.abs(a.awayScore - a.homeScore) <= 5;
    const bClose = b.status === 'in' && b.isLate && Math.abs(b.awayScore - b.homeScore) <= 5;
    if (aClose && !bClose) return -1;
    if (!aClose && bClose) return 1;
    const aOrd = stateOrder[a.status] ?? 4;
    const bOrd = stateOrder[b.status] ?? 4;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return 0;
  });
}

// ── Filter Pills ────────────────────────────────────────────────────
function Pills({ items, active, onChange, color = '#1F2937' }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '5px 0', WebkitOverflowScrolling: 'touch' }}>
      {items.map(item => (
        <button key={item} onClick={() => onChange(item)} style={{
          padding: '4px 14px', borderRadius: 20,
          border: active === item ? `2px solid ${color}` : '1.5px solid #D1D5DB',
          background: active === item ? color : 'white',
          color: active === item ? 'white' : '#4B5563',
          fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>{item}</button>
      ))}
    </div>
  );
}

// ── Best Bets Section ───────────────────────────────────────────────
function BestBets({ picks }) {
  const topPicks = [...picks].filter(p => p.units >= 0.15).sort((a, b) => b.units - a.units).slice(0, 5);
  if (!topPicks.length) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#111827', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>🔥</span> Top Plays
      </div>
      {topPicks.map((p, i) => (
        <div key={i} style={{
          background: 'linear-gradient(135deg, #111827 0%, #1F2937 100%)', borderRadius: 10, marginBottom: 6, padding: '10px 12px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
              <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>
              <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'white' }}>{p.pick} <span style={{ color: '#6EE7B7', fontWeight: 800 }}>{fmt(p.odds)}</span></div>
            <div style={{ fontSize: 10, color: '#9CA3AF' }}>{p.away} @ {p.home}</div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 10 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#6EE7B7' }}>{p.units}u</div>
            <span style={{ fontSize: 10, fontWeight: 700, color: confColor(p.confidence), background: 'rgba(255,255,255,0.1)', padding: '1px 6px', borderRadius: 10 }}>{String(p.confidence).replace('%', '')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Picks Tab ───────────────────────────────────────────────────────
function PicksTab({ picks, sf, bf, cf }) {
  const dedupedPicks = dedup(picks);
  const filtered = dedupedPicks.filter(p =>
    (sf === 'All' || p.league === sf) &&
    (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase()) &&
    (cf !== '0.2u+' || p.units >= 0.2)
  );

  const games = {};
  for (const p of filtered) {
    const k = `${p.league}|${p.away}@${p.home}`;
    if (!games[k]) games[k] = { ...p, picks: [] };
    games[k].picks.push(p);
  }

  if (!Object.keys(games).length) return <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 40, fontSize: 14 }}>No picks match filters</div>;

  return (
    <>
      {cf !== '0.2u+' && sf === 'All' && bf === 'All' && <BestBets picks={dedupedPicks} />}
      {Object.values(games).map((g, i) => (
        <div key={i} style={{ background: 'white', borderRadius: 12, marginBottom: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: LEAGUE_BG[g.league] || '#F9FAFB', borderBottom: '1px solid #F3F4F6' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ background: LEAGUE_COLORS[g.league] || '#6B7280', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{g.league}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{g.away} @ {g.home}</span>
            </div>
            {g.startTime && <span style={{ fontSize: 10, color: '#6B7280', fontWeight: 600 }}>{cleanTime(g.startTime)}</span>}
          </div>
          {g.picks.map((p, j) => {
            const dimmed = p.units === 0;
            return (
              <div key={j} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: j < g.picks.length - 1 ? '1px solid #F9FAFB' : 'none', opacity: dimmed ? 0.45 : 1 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{p.pick}</span>
                    {p.line && <span style={{ fontSize: 11, color: '#9CA3AF' }}>{p.line}</span>}
                  </div>
                  {p.rationale && <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.rationale}</div>}
                </div>
                <div style={{ textAlign: 'right', marginLeft: 10, flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{fmt(p.odds)}</div>
                  <div style={{ fontSize: 11, color: '#6B7280' }}>{p.units}u</div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: confColor(p.confidence), background: confBg(p.confidence), padding: '1px 5px', borderRadius: 10 }}>{String(p.confidence).replace('%', '')}</span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ── Scores Tab ──────────────────────────────────────────────────────
function ScoresTab({ liveGames, picks, sf, bf }) {
  const [expanded, setExpanded] = useState({});
  const sportFiltered = liveGames.filter(g =>
    sf === 'All' ? true : sf === 'Live' ? g.status === 'in' : g.league === sf
  );
  const sorted = sortGames(sportFiltered);

  return sorted.length === 0
    ? <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 40, fontSize: 14 }}>{sf === 'Live' ? 'No live games right now' : 'No games today'}</div>
    : sorted.map((game, i) => {
      const gamePicks = picks.filter(p =>
        p.league === game.league && p.away === game.away && p.home === game.home &&
        (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase())
      );
      const trend = getTrend(gamePicks, game);
      const isPre = game.status === 'pre';
      const isLive = game.status === 'in';
      const isPost = game.status === 'post';
      const diff = Math.abs(game.awayScore - game.homeScore);
      const isClose = isLive && game.isLate && diff <= 5;

      let tBorder = '#E5E7EB';
      let tBg = 'transparent';
      if (isClose) { tBorder = '#F59E0B'; tBg = 'rgba(245,158,11,0.06)'; }
      else if (trend !== null && trend > 0.3) { tBorder = '#059669'; tBg = 'rgba(5,150,105,0.06)'; }
      else if (trend !== null && trend < -0.3) { tBorder = '#DC2626'; tBg = 'rgba(220,38,38,0.05)'; }

      const isExp = expanded[i];
      const gameKey = `${game.league}|${game.away}@${game.home}`;

      let statusText = '';
      let statusColor = '#9CA3AF';
      if (isPre) { statusText = cleanTime(game.period) || 'Pregame'; statusColor = '#9CA3AF'; }
      else if (isClose) { statusText = '🔥 Close game!'; statusColor = '#F59E0B'; }
      else if (isLive && trend !== null) {
        if (trend > 0.3) { statusText = 'Picks trending well'; statusColor = '#059669'; }
        else if (trend < -0.3) { statusText = 'Picks struggling'; statusColor = '#DC2626'; }
        else { statusText = 'Even'; statusColor = '#9CA3AF'; }
      }
      else if (isPost) { statusText = 'Final'; statusColor = '#6B7280'; }

      return (
        <div key={gameKey + i} style={{ background: 'white', borderRadius: 12, marginBottom: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `2px solid ${tBorder}` }}>
          {isClose && <div style={{ background: '#FEF3C7', color: '#92400E', fontSize: 11, fontWeight: 700, padding: '4px 12px', textAlign: 'center' }}>CLOSE GAME — Tune in!</div>}
          <div onClick={() => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))} style={{ padding: '10px 12px', cursor: 'pointer', background: tBg }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ background: LEAGUE_COLORS[game.league], color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{game.league}</span>
                {isLive && <span style={{ width: 6, height: 6, borderRadius: 3, background: '#059669', display: 'inline-block' }} />}
                <span style={{ fontSize: 10, fontWeight: 600, color: statusColor }}>{statusText}</span>
              </div>
              {isLive && <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 600 }}>{cleanTime(game.period)}</span>}
              {isPre && game.period && <span style={{ fontSize: 11, color: '#9CA3AF' }}>{cleanTime(game.period)}</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ textAlign: 'right', flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{game.away}</div>
              </div>
              {isPre ? (
                <span style={{ fontSize: 16, fontWeight: 700, color: '#9CA3AF', padding: '0 8px' }}>vs</span>
              ) : (
                <>
                  <span style={{ fontSize: 26, fontWeight: 800, color: game.awayScore >= game.homeScore ? '#111827' : '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>{game.awayScore}</span>
                  <span style={{ fontSize: 14, color: '#D1D5DB' }}>-</span>
                  <span style={{ fontSize: 26, fontWeight: 800, color: game.homeScore >= game.awayScore ? '#111827' : '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>{game.homeScore}</span>
                </>
              )}
              <div style={{ textAlign: 'left', flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{game.home}</div>
              </div>
            </div>
            {gamePicks.length > 0 && (
              <div style={{ textAlign: 'center', fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>{isExp ? '▲ Hide picks' : `▼ ${gamePicks.length} picks`}</div>
            )}
          </div>
          {isExp && gamePicks.map((p, j) => {
            const status = getPickStatus(p, game);
            const icon = status === 'winning' ? '✅' : status === 'losing' ? '❌' : '➖';
            return (
              <div key={j} style={{
                display: 'flex', justifyContent: 'space-between', padding: '7px 12px',
                background: status === 'winning' ? 'rgba(5,150,105,0.04)' : status === 'losing' ? 'rgba(220,38,38,0.04)' : 'transparent',
                borderTop: '1px solid #F3F4F6'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 13 }}>{icon}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{p.pick}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>{fmt(p.odds)}</span>
                  <span style={{ fontSize: 11, color: '#9CA3AF' }}>{p.units}u</span>
                </div>
              </div>
            );
          })}
        </div>
      );
    });
}

// ── Props Tab ───────────────────────────────────────────────────────
function PropsTab({ props, sf }) {
  const filtered = props.filter(p => {
    if (sf === 'All' || sf === 'Live') return true;
    // Try to match sport from the games text or sport field
    const sportText = (p.sport || '').toUpperCase();
    return sportText === sf || sportText.includes(sf);
  });

  if (!filtered.length) return <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 40, fontSize: 14 }}>No props available</div>;

  // Group by combo (using the games field as key)
  return filtered.map((p, i) => {
    // Parse the combined text to extract player info
    const pickText = (p.pick || '').trim();
    const lineText = (p.line || '').trim();
    const playerText = p.player || '';

    // Determine if this is a combo-format row (games in sport field)
    const isCombo = (p.sport || '').includes('@');

    // Try to extract meaningful display info
    let displayPlayer = playerText;
    let displayStat = (p.market || '').replace(/^(player_|pitcher_|batter_)/, '').replace(/_/g, ' ');
    let displayDirection = pickText;
    let displayLine = lineText;
    let displayConf = p.confidence;
    let sportBadge = p.sport || '';

    // If combo format, the fields are shifted
    if (isCombo) {
      // sport field has games, player has a number, market has a number,
      // pick has status/direction, line has the actual description
      displayPlayer = lineText; // "Nico Hischier shots on goal LEAN UNDER"
      displayStat = '';
      displayDirection = '';
      displayLine = playerText; // the number
      displayConf = p.confidence;
      sportBadge = '';

      // Try to parse "Player Name stat LEAN OVER/UNDER" from the description
      const leanMatch = displayPlayer.match(/^(.+?)\s+(LEAN\s+(?:OVER|UNDER))$/i);
      if (leanMatch) {
        displayPlayer = leanMatch[1].trim();
        displayDirection = leanMatch[2].trim();
      }
      // Try to extract stat type
      const statMatch = displayPlayer.match(/^(.+?)\s+(points|rebounds|assists|shots on goal|saves|blocks|strikeouts|hits|home runs|RBIs|passing yards|rushing yards|receiving yards|touchdowns|goals|three pointers|threes|steals)$/i);
      if (statMatch) {
        displayPlayer = statMatch[1].trim();
        displayStat = statMatch[2].trim();
      }
    }

    const isOver = displayDirection.toLowerCase().includes('over');
    const isUnder = displayDirection.toLowerCase().includes('under');

    return (
      <div key={i} style={{ background: 'white', borderRadius: 12, marginBottom: 6, padding: '10px 12px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {sportBadge && !isCombo && (
              <span style={{ background: LEAGUE_COLORS[sportBadge] || '#6B7280', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3, marginRight: 5 }}>{sportBadge}</span>
            )}
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 2 }}>{displayPlayer}</div>
            {displayStat && <div style={{ fontSize: 11, color: '#4B5563', marginBottom: 2 }}>{displayStat}</div>}
            {p.rationale && <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.rationale}</div>}
            {isCombo && p.sport && (
              <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 3, lineHeight: 1.4 }}>
                {p.sport.split('+').map((g, gi) => <div key={gi}>{g.trim()}</div>)}
              </div>
            )}
          </div>
          <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0 }}>
            {displayDirection && (
              <div style={{ fontSize: 11, fontWeight: 800, color: isOver ? '#059669' : isUnder ? '#DC2626' : '#6B7280', textTransform: 'uppercase', marginBottom: 2 }}>{displayDirection}</div>
            )}
            {displayLine && <div style={{ fontSize: 18, fontWeight: 800 }}>{displayLine}</div>}
            {displayConf > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: confColor(displayConf), background: confBg(displayConf), padding: '1px 5px', borderRadius: 10 }}>{displayConf}/10</span>
            )}
          </div>
        </div>
      </div>
    );
  });
}

// ── Results Tab ─────────────────────────────────────────────────────
function ResultsTab({ results, sf, bf, dateFilter }) {
  // Date filtering
  const now = new Date();
  const todayStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);

  const parseDate = (d) => {
    if (!d) return null;
    const parts = d.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  };

  const filtered = results.filter(r => {
    if (sf !== 'All' && r.league !== sf) return false;
    if (bf !== 'All' && (r.betType || r.market || '').toLowerCase() !== bf.toLowerCase()) return false;
    if (dateFilter === 'Today') return r.date === todayStr;
    if (dateFilter === 'Yesterday') return r.date === yesterdayStr;
    if (dateFilter === 'Last 7 Days') {
      const d = parseDate(r.date);
      return d && d >= weekAgo;
    }
    return true;
  });

  const wins = filtered.filter(r => r.result === 'W').length;
  const losses = filtered.filter(r => r.result === 'L').length;
  const pushes = filtered.filter(r => r.result === 'P').length;
  const totalReturn = filtered.reduce((s, r) => s + (r.unitReturn || 0), 0);
  const totalWagered = filtered.reduce((s, r) => s + (r.units || 0), 0);
  const winPct = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0';
  const roi = totalWagered > 0 ? ((totalReturn / totalWagered) * 100).toFixed(1) : '0';

  const byDate = {};
  for (const r of filtered) { if (!byDate[r.date]) byDate[r.date] = []; byDate[r.date].push(r); }
  // Sort dates newest first
  const sortedDates = Object.keys(byDate).sort((a, b) => {
    const da = parseDate(a), db = parseDate(b);
    return (db?.getTime() || 0) - (da?.getTime() || 0);
  });

  return (
    <>
      <div style={{ background: 'white', borderRadius: 12, padding: '12px 14px', marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, textAlign: 'center' }}>
        <div><div style={{ fontSize: 18, fontWeight: 800 }}>{wins}-{losses}{pushes ? `-${pushes}` : ''}</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>RECORD</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800 }}>{winPct}%</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>WIN %</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: totalReturn >= 0 ? '#059669' : '#DC2626' }}>{totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>UNITS</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: parseFloat(roi) >= 0 ? '#059669' : '#DC2626' }}>{roi}%</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>ROI</div></div>
      </div>
      {!filtered.length && <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 30, fontSize: 13 }}>No graded results for this period</div>}
      {sortedDates.map(date => {
        const bets = byDate[date];
        const dayReturn = bets.reduce((s, r) => s + (r.unitReturn || 0), 0);
        return (
          <div key={date} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 2px', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{date}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: dayReturn >= 0 ? '#059669' : '#DC2626' }}>{dayReturn >= 0 ? '+' : ''}{dayReturn.toFixed(2)}u</span>
            </div>
            {bets.map((r, j) => (
              <div key={j} style={{
                background: 'white', borderRadius: 8, marginBottom: 3, padding: '8px 12px',
                boxShadow: '0 1px 2px rgba(0,0,0,0.04)', display: 'flex', justifyContent: 'space-between',
                borderLeft: `3px solid ${r.result === 'W' ? '#059669' : r.result === 'L' ? '#DC2626' : '#D1D5DB'}`
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 1 }}>
                    <span style={{ background: LEAGUE_COLORS[r.league], color: 'white', fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3 }}>{r.league}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', padding: '1px 4px', borderRadius: 3, textTransform: 'uppercase' }}>{r.betType || r.market}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{r.pick} <span style={{ color: '#9CA3AF', fontWeight: 400 }}>{fmt(r.odds)}</span></div>
                  <div style={{ fontSize: 10, color: '#9CA3AF' }}>{r.away} @ {r.home}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: r.result === 'W' ? '#059669' : r.result === 'L' ? '#DC2626' : '#6B7280' }}>{r.result}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: r.unitReturn >= 0 ? '#059669' : '#DC2626' }}>{r.unitReturn >= 0 ? '+' : ''}{(r.unitReturn || 0).toFixed(2)}u</div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

// ── Live Scores Fetcher (ESPN) ──────────────────────────────────────
async function fetchLiveScores() {
  const games = [];
  for (const [league, cfg] of Object.entries(ESPN_SPORTS)) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.key}/${cfg.league}/scoreboard`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const event of (data.events || [])) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const homeTeam = comp.competitors?.find(c => c.homeAway === 'home');
        const awayTeam = comp.competitors?.find(c => c.homeAway === 'away');
        const status = event.status?.type?.state;
        const period = event.status?.type?.shortDetail || '';
        const clock = event.status?.displayClock || '';
        const periodNum = event.status?.period || 0;

        let isLate = false;
        if (league === 'NBA' && periodNum >= 4) isLate = true;
        if (league === 'NHL' && periodNum >= 3) isLate = true;
        if (league === 'NFL' && periodNum >= 4) isLate = true;
        if (league === 'MLB' && periodNum >= 7) isLate = true;

        games.push({
          league,
          home: homeTeam?.team?.displayName || '',
          away: awayTeam?.team?.displayName || '',
          homeScore: parseInt(homeTeam?.score) || 0,
          awayScore: parseInt(awayTeam?.score) || 0,
          status,
          period,
          clock,
          isLate,
        });
      }
    } catch (e) { /* skip */ }
  }
  return games;
}

// ── Main App ────────────────────────────────────────────────────────
export default function App() {
  // Smart default: Picks before 6PM ET, Scores after
  const getDefaultTab = () => {
    const hour = new Date().getHours();
    return hour < 18 ? 'picks' : 'scores';
  };

  const [tab, setTab] = useState(getDefaultTab);
  const [sf, setSf] = useState('All');
  const [bf, setBf] = useState('All');
  const [cf, setCf] = useState('All Bets');
  const [dateFilter, setDateFilter] = useState('Last 7 Days');
  const [data, setData] = useState(null);
  const [liveGames, setLiveGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Fetch sheet data
  useEffect(() => {
    fetch('/api/data')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); setLastUpdated(new Date()); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  // Fetch live scores every 30s
  const refreshScores = useCallback(async () => {
    const scores = await fetchLiveScores();
    setLiveGames(scores);
    setLastUpdated(new Date());
  }, []);

  useEffect(() => {
    refreshScores();
    const interval = setInterval(refreshScores, 30000);
    return () => clearInterval(interval);
  }, [refreshScores]);

  const liveCount = liveGames.filter(g => g.status === 'in').length;
  const closeCount = liveGames.filter(g => g.status === 'in' && g.isLate && Math.abs(g.awayScore - g.homeScore) <= 5).length;

  const sportPills = tab === 'scores' ? ['All', 'Live', 'NBA', 'NHL', 'MLB', 'NFL'] : SPORTS;

  const tabs = [
    { id: 'picks', label: 'Picks', icon: '📋' },
    { id: 'scores', label: 'Scores', icon: '🏟️' },
    { id: 'props', label: 'Props', icon: '🎯' },
    { id: 'results', label: 'Results', icon: '📊' },
  ];

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', background: '#F3F4F6', minHeight: '100vh', position: 'relative' }}>
      {/* Header */}
      <div style={{ background: '#111827', padding: '12px 14px 6px', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: 'white', letterSpacing: -0.5 }}>Shadow Bets</span>
            {liveCount > 0 && (
              <span style={{ fontSize: 9, color: '#6EE7B7', fontWeight: 600, background: 'rgba(110,231,183,0.15)', padding: '2px 7px', borderRadius: 10 }}>
                {liveCount} LIVE
              </span>
            )}
            {closeCount > 0 && (
              <span style={{ fontSize: 9, color: '#FCD34D', fontWeight: 700, background: 'rgba(252,211,77,0.2)', padding: '2px 7px', borderRadius: 10, animation: 'pulse 2s infinite' }}>
                🔥 {closeCount} CLOSE
              </span>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#9CA3AF' }}>{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            {lastUpdated && <div style={{ fontSize: 9, color: '#6B7280' }}>Updated {lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>}
          </div>
        </div>
        <Pills items={sportPills} active={sf} onChange={setSf} color="#6EE7B7" />
        {tab === 'picks' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color="#818CF8" />}
        {tab === 'picks' && <Pills items={CONFIDENCE_FILTERS} active={cf} onChange={setCf} color="#F59E0B" />}
        {tab === 'scores' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color="#818CF8" />}
        {tab === 'results' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color="#818CF8" />}
        {tab === 'results' && <Pills items={DATE_FILTERS} active={dateFilter} onChange={setDateFilter} color="#F59E0B" />}
      </div>

      {/* Pulse animation */}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }`}</style>

      {/* Content */}
      <div style={{ padding: '8px 12px 90px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 60, color: '#9CA3AF' }}>Loading...</div>}
        {error && <div style={{ textAlign: 'center', padding: 40, color: '#DC2626', fontSize: 13 }}>Error: {error}<br /><span style={{ fontSize: 11, color: '#9CA3AF' }}>Check Vercel env vars</span></div>}
        {data && tab === 'picks' && <PicksTab picks={data.todayPicks} sf={sf} bf={bf} cf={cf} />}
        {data && tab === 'scores' && <ScoresTab liveGames={liveGames} picks={data.todayPicks} sf={sf} bf={bf} />}
        {data && tab === 'props' && <PropsTab props={data.props} sf={sf} />}
        {data && tab === 'results' && <ResultsTab results={data.gradedPicks} sf={sf} bf={bf} dateFilter={dateFilter} />}
      </div>

      {/* Tab Bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: '100%', maxWidth: 480, background: 'white', borderTop: '1px solid #E5E7EB',
        display: 'flex', justifyContent: 'space-around',
        padding: '5px 0 env(safe-area-inset-bottom, 6px)', zIndex: 30,
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            padding: '3px 16px', color: tab === t.id ? '#111827' : '#9CA3AF',
            position: 'relative',
          }}>
            <span style={{ fontSize: 17 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: 700, borderBottom: tab === t.id ? '2px solid #111827' : '2px solid transparent', paddingBottom: 1 }}>{t.label}</span>
            {t.id === 'scores' && closeCount > 0 && (
              <span style={{ position: 'absolute', top: 0, right: 8, background: '#F59E0B', color: 'white', fontSize: 8, fontWeight: 800, width: 14, height: 14, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{closeCount}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
