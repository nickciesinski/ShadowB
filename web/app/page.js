'use client';
import { useState, useEffect, useCallback } from 'react';


// ── Injected Styles ────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('sb-custom-styles')) {
  const style = document.createElement('style');
  style.id = 'sb-custom-styles';
  style.textContent = `
    @keyframes flashGreen { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes flashRed { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes progressPulse { 0%,100% { opacity: 0.8; } 50% { opacity: 1; } }
  `;
  document.head.appendChild(style);
}

// ── Constants ───────────────────────────────────────────────────────
const SPORTS = ['All', 'NBA', 'NHL', 'MLB', 'NFL'];
const BET_TYPES = ['All', 'Spread', 'Moneyline', 'Total'];
const CONFIDENCE_FILTERS = ['All Bets', '0.2u+'];
// PLATFORMS is built dynamically from props data (see bookPills in App)
const LEAGUE_COLORS = { NBA: '#F97316', NHL: '#6B7280', MLB: '#2563EB', NFL: '#1D4ED8' };
const LEAGUE_BG = { NBA: 'rgba(249,115,22,0.12)', NHL: 'rgba(107,114,128,0.12)', MLB: 'rgba(37,99,235,0.12)', NFL: 'rgba(29,78,216,0.12)' };
const DATE_FILTERS = ['Today', 'Yesterday', 'Last 7 Days', 'All Time'];
const TAB_ACCENTS = {
  picks: { gradient: 'linear-gradient(135deg, #059669 0%, #10B981 50%, #064E3B 100%)', accent: '#10B981', glow: 'rgba(16,185,129,0.3)' },
  scores: { gradient: 'linear-gradient(135deg, #2563EB 0%, #3B82F6 50%, #1E3A5F 100%)', accent: '#3B82F6', glow: 'rgba(59,130,246,0.3)' },
  props: { gradient: 'linear-gradient(135deg, #7C3AED 0%, #8B5CF6 50%, #4C1D95 100%)', accent: '#8B5CF6', glow: 'rgba(139,92,246,0.3)' },
  results: { gradient: 'linear-gradient(135deg, #D97706 0%, #F59E0B 50%, #78350F 100%)', accent: '#F59E0B', glow: 'rgba(245,158,11,0.3)' },
  settings: { gradient: 'linear-gradient(135deg, #64748B 0%, #94A3B8 50%, #334155 100%)', accent: '#94A3B8', glow: 'rgba(148,163,184,0.3)' },
};

const ESPN_SPORTS = {
  NBA: { key: 'basketball', league: 'nba' },
  NHL: { key: 'hockey', league: 'nhl' },
  MLB: { key: 'baseball', league: 'mlb' },
  NFL: { key: 'football', league: 'nfl' },
};

// ── Team Logos ──────────────────────────────────────────────────────
const TEAM_CODES = {
  // NBA
  'Atlanta Hawks': 'atl', 'Boston Celtics': 'bos', 'Brooklyn Nets': 'bkn', 'Charlotte Hornets': 'cha', 'Chicago Bulls': 'chi',
  'Cleveland Cavaliers': 'cle', 'Dallas Mavericks': 'dal', 'Denver Nuggets': 'den', 'Detroit Pistons': 'det', 'Golden State Warriors': 'gs',
  'Houston Rockets': 'hou', 'Los Angeles Clippers': 'lac', 'Los Angeles Lakers': 'lal', 'Memphis Grizzlies': 'mem', 'Miami Heat': 'mia',
  'Milwaukee Bucks': 'mil', 'Minnesota Timberwolves': 'min', 'New Orleans Pelicans': 'no', 'New York Knicks': 'ny', 'Oklahoma City Thunder': 'okc',
  'Orlando Magic': 'orl', 'Philadelphia 76ers': 'phi', 'Phoenix Suns': 'phx', 'Portland Trail Blazers': 'por', 'Sacramento Kings': 'sac',
  'San Antonio Spurs': 'sa', 'Toronto Raptors': 'tor', 'Utah Jazz': 'utah', 'Washington Wizards': 'wsh',
  // NHL
  'Anaheim Ducks': 'ana', 'Arizona Coyotes': 'ari', 'Boston Bruins': 'bos', 'Buffalo Sabres': 'buf', 'Calgary Flames': 'cgy',
  'Carolina Hurricanes': 'car', 'Chicago Blackhawks': 'chi', 'Colorado Avalanche': 'col', 'Columbus Blue Jackets': 'cbj', 'Dallas Stars': 'dal',
  'Detroit Red Wings': 'det', 'Edmonton Oilers': 'edm', 'Florida Panthers': 'fla', 'Los Angeles Kings': 'la', 'Minnesota Wild': 'min',
  'Montreal Canadiens': 'mtl', 'Nashville Predators': 'nsh', 'New Jersey Devils': 'nj', 'New York Islanders': 'nyi', 'New York Rangers': 'nyr',
  'Ottawa Senators': 'ott', 'Philadelphia Flyers': 'phi', 'Pittsburgh Penguins': 'pit', 'San Jose Sharks': 'sj', 'Seattle Kraken': 'sea',
  'St. Louis Blues': 'stl', 'Tampa Bay Lightning': 'tb', 'Toronto Maple Leafs': 'tor', 'Vancouver Canucks': 'van', 'Vegas Golden Knights': 'vgk',
  'Washington Capitals': 'wsh', 'Winnipeg Jets': 'wpg',
  // MLB
  'Arizona Diamondbacks': 'ari', 'Atlanta Braves': 'atl', 'Baltimore Orioles': 'bal', 'Boston Red Sox': 'bos', 'Chicago Cubs': 'chc',
  'Chicago White Sox': 'cws', 'Cincinnati Reds': 'cin', 'Cleveland Guardians': 'cle', 'Colorado Rockies': 'col', 'Detroit Tigers': 'det',
  'Houston Astros': 'hou', 'Kansas City Royals': 'kc', 'Los Angeles Angels': 'laa', 'Los Angeles Dodgers': 'lad', 'Miami Marlins': 'mia',
  'Milwaukee Brewers': 'mil', 'Minnesota Twins': 'min', 'New York Mets': 'nym', 'New York Yankees': 'nyy', 'Oakland Athletics': 'oak',
  'Philadelphia Phillies': 'phi', 'Pittsburgh Pirates': 'pit', 'San Diego Padres': 'sd', 'San Francisco Giants': 'sf', 'Seattle Mariners': 'sea',
  'St. Louis Cardinals': 'stl', 'Tampa Bay Rays': 'tb', 'Texas Rangers': 'tex', 'Toronto Blue Jays': 'tor', 'Washington Nationals': 'wsh',
  // NFL
  'Arizona Cardinals': 'ari', 'Atlanta Falcons': 'atl', 'Baltimore Ravens': 'bal', 'Buffalo Bills': 'buf', 'Carolina Panthers': 'car',
  'Chicago Bears': 'chi', 'Cincinnati Bengals': 'cin', 'Cleveland Browns': 'cle', 'Dallas Cowboys': 'dal', 'Denver Broncos': 'den',
  'Detroit Lions': 'det', 'Green Bay Packers': 'gb', 'Houston Texans': 'hou', 'Indianapolis Colts': 'ind', 'Jacksonville Jaguars': 'jax',
  'Kansas City Chiefs': 'kc', 'Las Vegas Raiders': 'lv', 'Los Angeles Chargers': 'lac', 'Los Angeles Rams': 'lar', 'Miami Dolphins': 'mia',
  'Minnesota Vikings': 'min', 'New England Patriots': 'ne', 'New Orleans Saints': 'no', 'New York Giants': 'nyg', 'New York Jets': 'nyj',
  'Philadelphia Eagles': 'phi', 'Pittsburgh Steelers': 'pit', 'San Francisco 49ers': 'sf', 'Seattle Seahawks': 'sea', 'Tampa Bay Buccaneers': 'tb',
  'Tennessee Titans': 'ten', 'Washington Commanders': 'wsh',
};

// ── Helpers ─────────────────────────────────────────────────────────
const fmt = (odds) => (odds > 0 ? `+${odds}` : `${odds}`);
const confColor = (c) => { const n = parseFloat(c) || 0; return n >= 8 ? '#34D399' : n >= 6 ? '#FBBF24' : '#64748B'; };
const confBg = (c) => { const n = parseFloat(c) || 0; return n >= 8 ? 'rgba(16,185,129,0.15)' : n >= 6 ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.08)'; };

function teamLogo(teamName, league) {
  const code = TEAM_CODES[teamName];
  if (!code) return null;
  const sport = { NBA: 'nba', NHL: 'nhl', MLB: 'mlb', NFL: 'nfl' }[league] || 'nba';
  return `https://a.espncdn.com/i/teamlogos/${sport}/500/${code}.png`;
}

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
    const pickTeam = (pick.pick || '').toLowerCase();
    const home = (game.home || '').toLowerCase();
    const away = (game.away || '').toLowerCase();
    if (aS === hS) return 'even';
    const pickedHome = pickTeam.includes(home) || home.includes(pickTeam);
    if (pickedHome) return hS > aS ? 'winning' : 'losing';
    return aS > hS ? 'winning' : 'losing';
  }
  if (bt === 'spread') {
    const line = parseFloat(pick.line) || 0;
    const pickTeam = (pick.pick || '').toLowerCase();
    const home = (game.home || '').toLowerCase();
    const isHome = pickTeam.includes(home) || home.includes(pickTeam);
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
  const leagueOrder = { NBA: 0, NHL: 1, MLB: 2, NFL: 3 };
  return [...games].sort((a, b) => {
    // Close games always first
    const aClose = a.status === 'in' && a.isLate && Math.abs(a.awayScore - a.homeScore) <= 5;
    const bClose = b.status === 'in' && b.isLate && Math.abs(b.awayScore - b.homeScore) <= 5;
    if (aClose && !bClose) return -1;
    if (!aClose && bClose) return 1;
    // Then by game state (live > post > pre)
    const aOrd = stateOrder[a.status] ?? 4;
    const bOrd = stateOrder[b.status] ?? 4;
    if (aOrd !== bOrd) return aOrd - bOrd;
    // Then by start time
    const aTime = a.gameDate ? new Date(a.gameDate).getTime() : 0;
    const bTime = b.gameDate ? new Date(b.gameDate).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    // Then by sport
    const aL = leagueOrder[a.league] ?? 9;
    const bL = leagueOrder[b.league] ?? 9;
    return aL - bL;
  });
}


// ── Game Progress (0-1) for progress bar ────────────────────────────
function getGameProgress(game) {
  if (!game || game.status === 'pre') return 0;
  if (game.status === 'post' || game.status === 'postponed') return 1;
  const pNum = game.periodNum || 0;
  const totalPeriods = { NBA: 4, NHL: 3, NFL: 4, MLB: 9 }[game.league] || 4;
  // pNum is 1-indexed current period; for MLB "Top 5th" = period 5
  // Base progress = completed periods / total
  const base = Math.max(0, (pNum - 1)) / totalPeriods;
  // Add partial credit (~half of current period)
  const partial = 0.5 / totalPeriods;
  return Math.min(base + partial, 0.98); // never fully 1 while live
}

// ── Filter Pills ────────────────────────────────────────────────────
function Pills({ items, active, onChange, color = '#1F2937' }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '5px 0', WebkitOverflowScrolling: 'touch' }}>
      {items.map(item => (
        <button key={item} onClick={() => onChange(item)} style={{
          padding: '4px 14px', borderRadius: 20,
          border: active === item ? `2px solid ${color}` : '1.5px solid rgba(255,255,255,0.12)',
          background: active === item ? color : 'transparent',
          color: active === item ? 'white' : '#94A3B8',
          fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>{item}</button>
      ))}
    </div>
  );
}

// ── Team Logo Component ──────────────────────────────────────────────
function TeamLogo({ team, league, size = 20 }) {
  const url = teamLogo(team, league);
  if (!url) return null;
  return <img src={url} alt="" style={{ width: size, height: size, objectFit: 'contain' }} />;
}

// ── Best Bets Section ───────────────────────────────────────────────
function BestBets({ picks }) {
  const topPicks = [...picks].filter(p => p.units >= 0.15).sort((a, b) => b.units - a.units).slice(0, 5);
  if (!topPicks.length) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#F1F5F9', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>🔥</span> Top Plays
      </div>
      {topPicks.map((p, i) => (
        <div key={i} style={{
          background: 'linear-gradient(135deg, #111827 0%, #1E293B 100%)', borderRadius: 10, marginBottom: 6, padding: '10px 12px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: '3px solid #10B981',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
              <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>
              <span style={{ fontSize: 10, color: '#64748B', fontWeight: 600, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'white' }}>{p.pick} <span style={{ color: '#34D399', fontWeight: 800 }}>{fmt(p.odds)}</span></div>
            <div style={{ fontSize: 10, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <TeamLogo team={p.away} league={p.league} size={14} />
              <span>{p.away} @ {p.home}</span>
              <TeamLogo team={p.home} league={p.league} size={14} />
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 10 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#34D399' }}>{p.units}u</div>
            <span style={{ fontSize: 10, fontWeight: 700, color: confColor(p.confidence), background: confBg(p.confidence), padding: '1px 6px', borderRadius: 10 }}>{String(p.confidence).replace('%', '')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Morning Summary Card ────────────────────────────────────────────
function MorningSummary({ picks, isBet, isFade, onLockAll }) {
  const qualifiedPicks = picks.filter(p => p.units >= 0.2);
  const totalPlays = picks.length;
  const totalUnits = picks.reduce((s, p) => s + (p.units || 0), 0);
  const lockedCount = picks.filter(p => isBet(p)).length;
  const fadedCount = picks.filter(p => isFade(p)).length;
  const unlockedQualified = qualifiedPicks.filter(p => !isBet(p) && !isFade(p)).length;
  const leagueCounts = {};
  for (const p of picks) { leagueCounts[p.league] = (leagueCounts[p.league] || 0) + 1; }

  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(5,150,105,0.04) 100%)', borderRadius: 12, padding: '12px 14px', marginBottom: 10, border: '1px solid rgba(16,185,129,0.15)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#F1F5F9' }}>Today's Slate</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {Object.entries(leagueCounts).map(([lg, ct]) => (
            <span key={lg} style={{ fontSize: 9, fontWeight: 700, color: 'white', background: LEAGUE_COLORS[lg] || '#6B7280', padding: '2px 6px', borderRadius: 4 }}>{lg} {ct}</span>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10, textAlign: 'center' }}>
        <div><div style={{ fontSize: 20, fontWeight: 900, color: '#F1F5F9' }}>{totalPlays}</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>PLAYS</div></div>
        <div><div style={{ fontSize: 20, fontWeight: 900, color: '#10B981' }}>{totalUnits.toFixed(1)}u</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>AT RISK</div></div>
        <div><div style={{ fontSize: 20, fontWeight: 900, color: '#8B5CF6' }}>{lockedCount}{fadedCount > 0 ? <span style={{ color: '#FB923C', fontSize: 14 }}>/{fadedCount}</span> : ''}</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>{fadedCount > 0 ? 'LOCKED/FADED' : 'LOCKED'}</div></div>
      </div>
      {unlockedQualified > 0 && (
        <button onClick={onLockAll} style={{
          width: '100%', padding: '10px 0', borderRadius: 8, border: '2px solid rgba(16,185,129,0.4)',
          background: 'linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(5,150,105,0.15) 100%)',
          color: '#34D399', fontSize: 13, fontWeight: 800, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 16 }}>⚡</span> Lock All 0.2u+ ({unlockedQualified} picks)
        </button>
      )}
      {unlockedQualified === 0 && lockedCount > 0 && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#34D399', fontWeight: 700, padding: '4px 0' }}>All qualified picks locked in</div>
      )}
    </div>
  );
}

// ── Picks Tab ───────────────────────────────────────────────────────
function PicksTab({ picks, sf, bf, cf, isBet, isFade, toggleBet, liveGames, lockAll }) {
  const dedupedPicks = dedup(picks);

  // My Bets filter
  if (sf === 'My Bets') {
    const myPicks = dedupedPicks.filter(p =>
      (isBet(p) || isFade(p)) &&
      (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase())
    );
    if (!myPicks.length) return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>No picks selected yet — tap picks to lock them in</div>;
    const games = {};
    for (const p of myPicks) {
      const k = `${p.league}|${p.away}@${p.home}|${p.startTime || ''}`;
      if (!games[k]) games[k] = { ...p, picks: [] };
      games[k].picks.push(p);
    }
    return (
      <>
        {Object.values(games).map((g, i) => (
          <div key={i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, marginBottom: 8, overflow: 'hidden', border: '1px solid rgba(139,92,246,0.2)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: LEAGUE_BG[g.league] || 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ background: LEAGUE_COLORS[g.league] || '#6B7280', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{g.league}</span>
                <TeamLogo team={g.away} league={g.league} size={16} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#F1F5F9' }}>{g.away} @ {g.home}</span>
                <TeamLogo team={g.home} league={g.league} size={16} />
              </div>
              {g.startTime && <span style={{ fontSize: 10, color: '#64748B', fontWeight: 600 }}>{cleanTime(g.startTime)}</span>}
            </div>
            {g.picks.map((p, j) => {
              const selected = isBet(p);
              const faded = isFade(p);
              return (
                <div key={j} onClick={() => toggleBet(p)} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', cursor: 'pointer',
                  borderBottom: j < g.picks.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                  background: faded ? 'rgba(249,115,22,0.12)' : 'rgba(139,92,246,0.12)',
                  borderLeft: faded ? '5px solid #FB923C' : '5px solid #A78BFA',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#FDBA74', background: 'rgba(249,115,22,0.25)', padding: '1px 5px', borderRadius: 3 }}>FADE</span>}
                    {selected && !faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#C4B5FD', background: 'rgba(139,92,246,0.25)', padding: '1px 5px', borderRadius: 3 }}>MY BET</span>}
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#F1F5F9' }}>{p.pick}</span>
                    {p.line && <span style={{ fontSize: 11, color: '#94A3B8' }}>{p.line}</span>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#F1F5F9' }}>{fmt(p.odds)}</div>
                    <div style={{ fontSize: 11, color: '#64748B' }}>{p.units}u</div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </>
    );
  }

  const filtered = dedupedPicks.filter(p =>
    (sf === 'All' || p.league === sf) &&
    (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase()) &&
    (cf !== '0.2u+' || p.units >= 0.2)
  );

  const games = {};
  for (const p of filtered) {
    // Include startTime in key to separate doubleheader games
    const k = `${p.league}|${p.away}@${p.home}|${p.startTime || ''}`;
    if (!games[k]) games[k] = { ...p, picks: [] };
    games[k].picks.push(p);
  }
  // Detect doubleheaders: same league+matchup with different start times
  const matchupCounts = {};
  for (const k of Object.keys(games)) {
    const g = games[k];
    const mk = `${g.league}|${g.away}@${g.home}`;
    if (!matchupCounts[mk]) matchupCounts[mk] = [];
    matchupCounts[mk].push(k);
  }
  for (const [mk, keys] of Object.entries(matchupCounts)) {
    if (keys.length > 1) {
      // Sort by startTime and assign game numbers
      keys.sort((a, b) => (games[a].startTime || '').localeCompare(games[b].startTime || ''));
      keys.forEach((k, i) => { games[k]._gameNum = i + 1; });
    }
  }

  if (!Object.keys(games).length) return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>No picks match filters</div>;

  return (
    <>
      {cf !== '0.2u+' && sf === 'All' && bf === 'All' && <MorningSummary picks={dedupedPicks} isBet={isBet} isFade={isFade} onLockAll={lockAll} />}
      {cf !== '0.2u+' && sf === 'All' && bf === 'All' && <BestBets picks={dedupedPicks} />}
      {Object.values(games).map((g, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, marginBottom: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: LEAGUE_BG[g.league] || 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ background: LEAGUE_COLORS[g.league] || '#6B7280', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{g.league}</span>
              <TeamLogo team={g.away} league={g.league} size={16} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#F1F5F9' }}>{g.away} @ {g.home}</span>
              <TeamLogo team={g.home} league={g.league} size={16} />
              {g._gameNum && <span style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', background: 'rgba(255,255,255,0.1)', padding: '1px 5px', borderRadius: 3 }}>GM {g._gameNum}</span>}
            </div>
            {g.startTime && <span style={{ fontSize: 10, color: '#64748B', fontWeight: 600 }}>{cleanTime(g.startTime)}</span>}
          </div>
          {/* MLB Starting Pitchers */}
          {g.league === 'MLB' && (() => {
            const matched = (liveGames || []).find(lg => lg.league === 'MLB' && lg.status === 'pre' &&
              g.home && lg.home && g.away && lg.away &&
              lg.home.toLowerCase().includes(g.home.split(' ').pop().toLowerCase()) &&
              lg.away.toLowerCase().includes(g.away.split(' ').pop().toLowerCase()));
            if (!matched || (!matched.homePitcher && !matched.awayPitcher)) return null;
            const ap = matched.awayPitcher;
            const hp = matched.homePitcher;
            return (
              <div style={{ padding: '3px 12px 5px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10, color: '#94A3B8' }}>&#9918;</span>
                <span style={{ fontSize: 10, color: '#94A3B8' }}>
                  {ap ? `${ap.name}${ap.era ? ` (${ap.era})` : ''}` : 'TBD'}
                  {' vs '}
                  {hp ? `${hp.name}${hp.era ? ` (${hp.era})` : ''}` : 'TBD'}
                </span>
              </div>
            );
          })()}
          {g.picks.map((p, j) => {
            const dimmed = p.units === 0;
            const selected = isBet(p);
            const faded = isFade(p);
            const bt = (p.betType || p.market || '').toLowerCase();
            const isTotal = bt === 'total';
            const isOverPick = isTotal && (p.pick || '').toLowerCase().includes('over');
            // For ML/spread, find the picked team for the big logo
            const pickedTeam = !isTotal ? p.pick : null;
            const pickedLogoUrl = pickedTeam ? teamLogo(pickedTeam, g.league) : null;
            return (
              <div key={j} onClick={() => toggleBet(p)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', cursor: 'pointer',
                borderBottom: j < g.picks.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                opacity: dimmed && !selected ? 0.35 : 1,
                background: faded ? 'rgba(249,115,22,0.12)' : selected ? 'rgba(139,92,246,0.12)' : 'transparent',
                borderLeft: faded ? '5px solid #FB923C' : selected ? '5px solid #A78BFA' : '3px solid transparent',
                transition: 'background 0.15s, border-left 0.15s',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    {faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#FDBA74', background: 'rgba(249,115,22,0.25)', padding: '1px 5px', borderRadius: 3 }}>FADE</span>}
                    {selected && !faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#C4B5FD', background: 'rgba(139,92,246,0.25)', padding: '1px 5px', borderRadius: 3 }}>MY BET</span>}
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#F1F5F9' }}>{p.pick}</span>
                    {p.line && <span style={{ fontSize: 11, color: '#94A3B8' }}>{p.line}</span>}
                  </div>
                  {p.rationale && <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.rationale}</div>}
                </div>
                {/* Big visual indicator: team logo for ML/spread, arrow for totals */}
                <div style={{ margin: '0 10px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: '50%', background: isTotal ? 'transparent' : 'rgba(255,255,255,0.08)', border: isTotal ? 'none' : '1px solid rgba(255,255,255,0.1)' }}>
                  {isTotal ? (
                    <span style={{ fontSize: 22, color: isOverPick ? '#34D399' : '#F87171', fontWeight: 900, lineHeight: 1 }}>{isOverPick ? '▲' : '▼'}</span>
                  ) : pickedLogoUrl ? (
                    <img src={pickedLogoUrl} alt="" style={{ width: 30, height: 30, objectFit: 'contain' }} />
                  ) : null}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#F1F5F9' }}>{fmt(p.odds)}</div>
                  <div style={{ fontSize: 11, color: '#64748B' }}>{p.units}u</div>
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
// Flip a pick to the opposite side (for fades)
function flipPick(p) {
  const bt = (p.betType || p.market || '').toLowerCase();
  if (bt === 'moneyline') {
    // Swap to the other team, invert odds sign as approximation
    const isHome = (p.pick || '').toLowerCase().includes((p.home || '').split(' ').pop().toLowerCase());
    const flippedOdds = p.odds > 0 ? -(p.odds) : Math.abs(p.odds);
    return { ...p, pick: isHome ? p.away : p.home, odds: flippedOdds };
  }
  if (bt === 'spread') {
    // Swap team + negate line (odds stay ~same for spreads, typically -110 both sides)
    const isHome = (p.pick || '').toLowerCase().includes((p.home || '').split(' ').pop().toLowerCase());
    const newLine = parseFloat(p.line) ? String(-parseFloat(p.line)) : p.line;
    return { ...p, pick: isHome ? p.away : p.home, line: newLine };
  }
  if (bt === 'total') {
    const isOver = (p.pick || '').toLowerCase().includes('over');
    return { ...p, pick: isOver ? `Under ${p.line}` : `Over ${p.line}` };
  }
  return p;
}

function ScoresTab({ liveGames, picks, sf, bf, isBet, isFade }) {
  const [expanded, setExpanded] = useState({});
  const [expandAll, setExpandAll] = useState(false);
  const sportFiltered = liveGames.filter(g => {
    if (sf === 'My Bets') {
      return picks.some(p => p.league === g.league && p.away === g.away && p.home === g.home && isBet(p));
    }
    return sf === 'All' ? true : sf === 'Live' ? g.status === 'in' : g.league === sf;
  });
  const sorted = sortGames(sportFiltered);

  // Abbreviate team names: use last word (e.g. "Golden State Warriors" → "Warriors")
  const abbr = (name) => (name || '').split(' ').pop();

  // Compute game data once for both compact and expanded views
  const gameData = sorted.map((game, i) => {
    const gamePicks = picks.filter(p =>
      p.league === game.league && p.away === game.away && p.home === game.home &&
      (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase())
    );
    const displayPicks = gamePicks.map(p => isFade(p) ? flipPick(p) : p);
    const trend = getTrend(displayPicks, game);
    const isPre = game.status === 'pre';
    const isLive = game.status === 'in';
    const isPost = game.status === 'post' || game.status === 'postponed';
    const diff = Math.abs(game.awayScore - game.homeScore);
    const isClose = isLive && game.isLate && diff <= 5;
    const hasBets = gamePicks.some(p => isBet(p));
    const hasFades = gamePicks.some(p => isFade(p));
    const isPostponed = game.status === 'postponed';
    const gameNumLabel = game.gameNum ? ` G${game.gameNum}` : '';
    const gameKey = `${game.league}|${game.away}@${game.home}`;

    let tBorder = hasFades ? '#FB923C' : hasBets ? '#8B5CF6' : 'rgba(255,255,255,0.08)';
    let tBg = 'transparent';
    if (isClose) { tBorder = '#F59E0B'; tBg = 'rgba(245,158,11,0.08)'; }
    else if (trend !== null && trend > 0.3) { tBorder = '#10B981'; tBg = 'rgba(16,185,129,0.08)'; }
    else if (trend !== null && trend < -0.3) { tBorder = '#EF4444'; tBg = 'rgba(220,38,38,0.08)'; }

    let statusText = '';
    let statusColor = '#64748B';
    if (isPostponed) { statusText = 'PPD'; statusColor = '#F59E0B'; }
    else if (isPre) { statusText = cleanTime(game.period) || 'Pre'; statusColor = '#64748B'; }
    else if (isLive) { statusText = cleanTime(game.period) || 'Live'; statusColor = '#34D399'; }
    else if (isPost) { statusText = 'Final'; statusColor = '#64748B'; }
    if (gameNumLabel) statusText = statusText + gameNumLabel;

    const cardOpacity = isPostponed ? 0.5 : isPost ? 0.7 : 1;
    const isExp = expandAll || (expanded[i] !== undefined ? expanded[i] : false);

    return { game, gamePicks, displayPicks, trend, isPre, isLive, isPost, isClose, hasBets, hasFades, isPostponed, tBorder, tBg, statusText, statusColor, cardOpacity, isExp, gameKey, i };
  });

  if (sorted.length === 0) {
    return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>{sf === 'Live' ? 'No live games right now' : 'No games today'}</div>;
  }

  // Expanded detail renderer (shared between compact-expand and expand-all)
  const renderExpanded = (d) => {
    const { game, gamePicks, displayPicks, isClose, tBorder, tBg, hasBets, hasFades, isLive, isPost, isPre, statusText, statusColor, cardOpacity, gameKey, i } = d;
    const cardBorder = isLive
      ? `${hasBets ? '3px' : '2px'} solid ${tBorder}`
      : isPost ? '1px solid rgba(255,255,255,0.06)' : `${hasBets ? '3px' : '2px'} solid ${tBorder}`;
    const cardLeftBar = isPost && !isLive ? `4px solid ${tBorder}` : undefined;
    const cardShadow = isLive
      ? (hasFades ? '0 2px 16px rgba(249,115,22,0.25)' : hasBets ? '0 2px 16px rgba(139,92,246,0.25)' : '0 2px 12px rgba(0,0,0,0.4)')
      : '0 1px 6px rgba(0,0,0,0.2)';

    return (
      <div key={gameKey + i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, marginBottom: 8, overflow: 'hidden', border: cardBorder, borderLeft: cardLeftBar || undefined, boxShadow: cardShadow, opacity: cardOpacity, transition: 'all 0.3s ease', gridColumn: '1 / -1' }}>
        {isClose && <div style={{ background: 'rgba(245,158,11,0.15)', color: '#FCD34D', fontSize: 11, fontWeight: 700, padding: '4px 12px', textAlign: 'center' }}>CLOSE GAME — Tune in!</div>}
        <div onClick={() => { if (!expandAll) setExpanded(prev => ({ ...prev, [i]: false })); }} style={{ padding: '10px 12px', cursor: expandAll ? 'default' : 'pointer', background: tBg }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ background: LEAGUE_COLORS[game.league], color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{game.league}</span>
              {isLive && <span style={{ width: 8, height: 8, borderRadius: 4, background: '#34D399', display: 'inline-block', boxShadow: '0 0 6px rgba(52,211,153,0.6)', animation: 'pulse 2s infinite' }} />}
              <span style={{ fontSize: 10, fontWeight: 600, color: statusColor }}>{d.isClose ? '🔥 Close game!' : d.trend !== null && isLive ? (d.trend > 0.3 ? 'Trending well' : d.trend < -0.3 ? 'Struggling' : statusText) : statusText}</span>
            </div>
            {isLive && <span style={{ fontSize: 11, color: '#64748B', fontWeight: 600 }}>{cleanTime(game.period)}</span>}
            {isPre && game.period && <span style={{ fontSize: 11, color: '#64748B' }}>{cleanTime(game.period)}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={{ textAlign: 'right', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#F1F5F9' }}>{game.away}</div>
                <TeamLogo team={game.away} league={game.league} size={20} />
              </div>
            </div>
            {isPre ? (
              <span style={{ fontSize: 16, fontWeight: 700, color: '#475569', padding: '0 8px' }}>vs</span>
            ) : (
              <>
                <span style={{ fontSize: 26, fontWeight: 800, color: game.awayScore >= game.homeScore ? '#F1F5F9' : '#475569', fontVariantNumeric: 'tabular-nums' }}>{game.awayScore}</span>
                <span style={{ fontSize: 14, color: '#475569' }}>-</span>
                <span style={{ fontSize: 26, fontWeight: 800, color: game.homeScore >= game.awayScore ? '#F1F5F9' : '#475569', fontVariantNumeric: 'tabular-nums' }}>{game.homeScore}</span>
              </>
            )}
            <div style={{ textAlign: 'left', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TeamLogo team={game.home} league={game.league} size={20} />
                <div style={{ fontSize: 13, fontWeight: 600, color: '#F1F5F9' }}>{game.home}</div>
              </div>
            </div>
          </div>
          {!expandAll && <div style={{ textAlign: 'center', fontSize: 10, color: '#64748B', marginTop: 4 }}>▲ Collapse</div>}
        </div>
        {gamePicks.map((p, j) => {
          const faded = isFade(p);
          const displayPick = faded ? flipPick(p) : p;
          const status = getPickStatus(displayPick, game);
          const icon = status === 'winning' ? '✅' : status === 'losing' ? '❌' : '➖';
          const selected = isBet(p);
          let rowBg = 'transparent';
          if (selected) rowBg = status === 'winning' ? 'rgba(16,185,129,0.15)' : status === 'losing' ? 'rgba(220,38,38,0.15)' : (faded ? 'rgba(249,115,22,0.12)' : 'rgba(139,92,246,0.12)');
          else if (status === 'winning') rowBg = 'rgba(16,185,129,0.08)';
          else if (status === 'losing') rowBg = 'rgba(220,38,38,0.08)';
          return (
            <div key={j} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 12px', background: rowBg, borderTop: '1px solid rgba(255,255,255,0.06)', borderLeft: selected ? (faded ? '5px solid #FB923C' : '5px solid #A78BFA') : '3px solid transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 13 }}>{icon}</span>
                {faded && <span style={{ fontSize: 8, fontWeight: 700, color: '#FDBA74', background: 'rgba(249,115,22,0.25)', padding: '1px 4px', borderRadius: 3 }}>FADE</span>}
                {selected && !faded && <span style={{ fontSize: 8, fontWeight: 700, color: '#C4B5FD', background: 'rgba(139,92,246,0.25)', padding: '1px 4px', borderRadius: 3 }}>BET</span>}
                <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' }}>{displayPick.betType || displayPick.market}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#F1F5F9' }}>{displayPick.pick}</span>
                {displayPick.line && <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>{displayPick.line}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94A3B8' }}>{fmt(p.odds)}</span>
                <span style={{ fontSize: 11, color: '#64748B' }}>{p.units}u</span>
              </div>
            </div>
          );
        })}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 12px', background: 'rgba(255,255,255,0.02)' }}>
          {(game.awayLinescores?.length > 0 || game.homeLinescores?.length > 0) && (
            <div style={{ marginBottom: 8, overflowX: 'auto' }}>
              <div style={{ display: 'flex', gap: 0, fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ width: 70, color: '#64748B', padding: '2px 4px', flexShrink: 0 }}></div>
                {(game.awayLinescores || game.homeLinescores || []).map((_, pi) => (
                  <div key={pi} style={{ width: 24, textAlign: 'center', color: '#475569', padding: '2px 0', flexShrink: 0 }}>
                    {game.league === 'MLB' ? pi + 1 : `${game.league === 'NHL' ? 'P' : 'Q'}${pi + 1}`}
                  </div>
                ))}
                <div style={{ width: 30, textAlign: 'center', color: '#94A3B8', fontWeight: 700, padding: '2px 0', flexShrink: 0 }}>T</div>
              </div>
              {[{ team: game.away, scores: game.awayLinescores, total: game.awayScore },
                { team: game.home, scores: game.homeLinescores, total: game.homeScore }].map(row => (
                <div key={row.team} style={{ display: 'flex', gap: 0, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                  <div style={{ width: 70, color: '#94A3B8', fontWeight: 600, padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{row.team.split(' ').pop()}</div>
                  {(row.scores || []).map((s, si) => (
                    <div key={si} style={{ width: 24, textAlign: 'center', color: '#F1F5F9', padding: '2px 0', flexShrink: 0 }}>{s}</div>
                  ))}
                  <div style={{ width: 30, textAlign: 'center', color: '#F1F5F9', fontWeight: 800, padding: '2px 0', flexShrink: 0 }}>{row.total}</div>
                </div>
              ))}
            </div>
          )}
          {game.leaders?.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              {game.leaders.filter((l, li, arr) => arr.findIndex(x => x.category === l.category) === li).slice(0, 4).map((l, li) => (
                <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#475569', width: 50, textTransform: 'uppercase' }}>{l.shortCategory || l.category}</span>
                  <span style={{ fontSize: 10, color: '#F1F5F9', fontWeight: 600 }}>{l.athlete}</span>
                  <span style={{ fontSize: 10, color: '#64748B' }}>({l.team})</span>
                  <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{l.value}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 9, color: '#475569' }}>
            {game.awayRecord && <span>{game.away.split(' ').pop()} {game.awayRecord}</span>}
            {game.homeRecord && <span>{game.home.split(' ').pop()} {game.homeRecord}</span>}
            {game.venue && <span>{game.venue}</span>}
            {game.broadcast && <span>📺 {game.broadcast}</span>}
            {game.odds && <span>{game.odds}</span>}
          </div>
        </div>
        {(game.status === 'in' || game.status === 'post') && (
          <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: '0 0 12px 12px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${getGameProgress(game) * 100}%`, background: 'linear-gradient(90deg, rgba(255,255,255,0.25), rgba(255,255,255,0.45))', borderRadius: '0 0 12px 12px', transition: 'width 1s ease-in-out', animation: game.status === 'in' ? 'progressPulse 3s ease-in-out infinite' : 'none' }} />
          </div>
        )}
      </div>
    );
  };

  // Compact card renderer (for grid view)
  const renderCompact = (d) => {
    const { game, gamePicks, displayPicks, isLive, isPre, isPost, isClose, hasBets, hasFades, tBorder, tBg, statusText, statusColor, cardOpacity, gameKey, i } = d;
    const borderColor = isLive ? tBorder : isPost ? 'rgba(255,255,255,0.06)' : tBorder;
    const borderWidth = (isLive && hasBets) ? '2px' : isPost ? '1px' : (hasBets ? '2px' : '1px');

    return (
      <div key={gameKey + i} onClick={() => setExpanded(prev => ({ ...prev, [i]: true }))} style={{
        background: 'rgba(255,255,255,0.04)', borderRadius: 10, overflow: 'hidden',
        border: `${borderWidth} solid ${borderColor}`, cursor: 'pointer', opacity: cardOpacity,
        transition: 'all 0.2s ease', position: 'relative',
        boxShadow: isLive ? '0 2px 8px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.2)',
      }}>
        {isClose && <div style={{ background: 'rgba(245,158,11,0.2)', color: '#FCD34D', fontSize: 8, fontWeight: 800, padding: '2px 0', textAlign: 'center', letterSpacing: 0.5 }}>🔥 CLOSE</div>}
        <div style={{ padding: '8px 8px 6px', background: tBg }}>
          {/* Top row: league badge + status */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ background: LEAGUE_COLORS[game.league], color: 'white', fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 3 }}>{game.league}</span>
              {isLive && <span style={{ width: 6, height: 6, borderRadius: 3, background: '#34D399', display: 'inline-block', boxShadow: '0 0 4px rgba(52,211,153,0.6)', animation: 'pulse 2s infinite' }} />}
            </div>
            <span style={{ fontSize: 9, fontWeight: 600, color: statusColor }}>{statusText}</span>
          </div>
          {/* Teams + scores — stacked layout */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
                <TeamLogo team={game.away} league={game.league} size={14} />
                <span style={{ fontSize: 11, fontWeight: 600, color: (!isPre && game.awayScore >= game.homeScore) ? '#F1F5F9' : '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{abbr(game.away)}</span>
              </div>
              {!isPre && <span style={{ fontSize: 16, fontWeight: 800, color: game.awayScore >= game.homeScore ? '#F1F5F9' : '#475569', fontVariantNumeric: 'tabular-nums', minWidth: 22, textAlign: 'right' }}>{game.awayScore}</span>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
                <TeamLogo team={game.home} league={game.league} size={14} />
                <span style={{ fontSize: 11, fontWeight: 600, color: (!isPre && game.homeScore >= game.awayScore) ? '#F1F5F9' : '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{abbr(game.home)}</span>
              </div>
              {!isPre && <span style={{ fontSize: 16, fontWeight: 800, color: game.homeScore >= game.awayScore ? '#F1F5F9' : '#475569', fontVariantNumeric: 'tabular-nums', minWidth: 22, textAlign: 'right' }}>{game.homeScore}</span>}
              {isPre && <span style={{ fontSize: 10, color: '#475569', fontWeight: 600 }}>vs</span>}
            </div>
          </div>
          {/* Bottom: pick status dots with M/S/T labels */}
          {displayPicks.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 3, marginTop: 6, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              {displayPicks.map((dp, di) => {
                const origPick = gamePicks[di];
                const st = getPickStatus(dp, game);
                const isInProgress = game.status === 'in';
                const betted = origPick && isBet(origPick);
                const faded = origPick && isFade(origPick);
                const selected = betted || faded;
                let dotColor = '#475569';
                let anim = 'none';
                if (st === 'winning') { dotColor = '#10B981'; if (isInProgress) anim = 'flashGreen 1.5s ease-in-out infinite'; }
                else if (st === 'losing') { dotColor = '#EF4444'; if (isInProgress) anim = 'flashRed 1.5s ease-in-out infinite'; }
                else if (st === 'even') { dotColor = '#6B7280'; }
                else if (st === 'pending') { dotColor = '#475569'; }
                const bt = (dp.betType || dp.market || '').toLowerCase();
                const label = bt === 'moneyline' ? 'M' : bt === 'spread' ? 'S' : bt === 'total' ? 'T' : '?';
                const ringColor = faded ? '#FB923C' : betted ? '#A78BFA' : 'transparent';
                return (
                  <span key={di} style={{
                    width: 16, height: 16, borderRadius: '50%', background: dotColor,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 7, fontWeight: 800, color: 'white', animation: anim,
                    boxShadow: selected ? `0 0 0 2px ${ringColor}, 0 0 6px ${ringColor}` : 'none',
                    border: selected ? `1.5px solid ${ringColor}` : '1.5px solid transparent',
                  }}>{label}</span>
                );
              })}
            </div>
          )}
        </div>
        {/* Mini progress bar */}
        {(game.status === 'in' || game.status === 'post') && (
          <div style={{ height: 2, background: 'rgba(255,255,255,0.06)' }}>
            <div style={{ height: '100%', width: `${getGameProgress(game) * 100}%`, background: 'linear-gradient(90deg, rgba(255,255,255,0.25), rgba(255,255,255,0.45))', transition: 'width 1s ease-in-out', animation: game.status === 'in' ? 'progressPulse 3s ease-in-out infinite' : 'none' }} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Expand All toggle */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button onClick={() => { setExpandAll(!expandAll); if (!expandAll) setExpanded({}); }} style={{
          background: expandAll ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.06)',
          border: expandAll ? '1px solid rgba(59,130,246,0.3)' : '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
          fontSize: 10, fontWeight: 600, color: expandAll ? '#60A5FA' : '#64748B',
        }}>
          {expandAll ? '▫ Grid View' : '▦ Expand All'}
        </button>
      </div>
      {/* Grid of cards */}
      <div style={{ display: 'grid', gridTemplateColumns: expandAll ? '1fr' : 'repeat(2, 1fr)', gap: 8 }}>
        {gameData.map(d => d.isExp && !expandAll ? renderExpanded(d) : expandAll ? renderExpanded(d) : renderCompact(d))}
      </div>
    </div>
  );
}

// ── Props Tab ───────────────────────────────────────────────────────
function PropsTab({ props, todayGames, sf, pf, propDateFilter, isPropBet, isPropFade, toggleProp, liveStats, myPropBets }) {
  // Helper: format timestamp as relative time ago
  const timeAgo = (ts) => {
    if (!ts) return null;
    const diff = Math.max(0, Date.now() - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // Build game-to-date lookup from todayGames commence times
  const gameCommence = {};
  for (const g of (todayGames || [])) {
    const key = `${g.away} @ ${g.home}`;
    if (g.commence) gameCommence[key] = g.commence;
    // Also store with reversed order for flexibility
    const revKey = `${g.home} vs ${g.away}`;
    if (g.commence) gameCommence[revKey] = g.commence;
  }

  // Helper: get date string (YYYY-MM-DD in local time) from a prop's game
  const getPropDate = (p) => {
    const commence = gameCommence[p.game];
    if (!commence) return null;
    try {
      return new Date(commence).toLocaleDateString('en-CA'); // YYYY-MM-DD
    } catch { return null; }
  };

  const todayStr = new Date().toLocaleDateString('en-CA');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA');

  // "My Bets" view: show stored prop selections with locked-in lines
  if (sf === 'My Bets') {
    const myProps = (myPropBets || []).map(stored => {
      // Find matching current prop to get live stats context
      const currentProp = props.find(p =>
        p.player === stored.player && p.market === stored.market &&
        p.direction === stored.direction && p.book === stored.book
      );
      // Use stored line/odds but current prop's other data for live tracking
      return {
        ...(currentProp || {}),
        player: stored.player,
        league: stored.league,
        market: stored.market,
        direction: stored.direction,
        book: stored.book,
        game: stored.game || (currentProp ? currentProp.game : ''),
        line: stored.line, // locked-in line
        bookOdds: stored.odds, // locked-in odds
        selectedAt: stored.selectedAt || null,
        _isMyBet: true,
        _state: stored.state,
        // Keep current prop's consensus/edge if available
        consensusProb: currentProp ? currentProp.consensusProb : '',
        bookProb: currentProp ? currentProp.bookProb : '',
        edge: currentProp ? currentProp.edge : '',
      };
    });

    // Filter by sportsbook
    let myFiltered = myProps;
    if (pf !== 'All') myFiltered = myFiltered.filter(p => p.book === pf);

    if (!myFiltered.length) return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>No prop bets selected yet</div>;

    const isOver = (d) => (d || '').toLowerCase() === 'over';

    return (
      <>
        <div style={{ background: 'rgba(139,92,246,0.08)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, border: '1px solid rgba(139,92,246,0.2)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C4B5FD' }}>My Prop Bets</div>
          <div style={{ fontSize: 11, color: '#64748B' }}>{myFiltered.length} selections</div>
        </div>
        {myFiltered.map((p, i) => {
          const edgeNum = parseFloat(p.edge) || 0;
          const edgeColor = edgeNum >= 8 ? '#34D399' : edgeNum >= 5 ? '#FBBF24' : '#64748B';
          const dirColor = isOver(p.direction) ? '#34D399' : '#F87171';
          const faded = p._state === 'fade';
          const live = liveStats[`prop|${p.league}|${p.player}|${p.market}|${p.direction}|${p.book}`] || null;
          const lineNum = parseFloat(p.line) || 0;
          const isOverBet = isOver(p.direction);

          let statStatus = null, statColor = '#64748B', statLabel = '';
          if (live) {
            const cur = live.current;
            const isGameOver = live.gameStatus === 'post';
            const diff = lineNum - cur;
            if (isOverBet) {
              if (cur >= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = isGameOver ? 'HIT ✅' : 'OVER ✅'; }
              else if (isGameOver) { statStatus = 'miss'; statColor = '#F87171'; statLabel = 'MISSED ❌'; }
              else if (diff <= 3) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
              else { statStatus = 'behind'; statColor = '#94A3B8'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
            } else {
              if (isGameOver && cur <= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = 'HIT ✅'; }
              else if (cur > lineNum) { statStatus = 'miss'; statColor = '#F87171'; statLabel = isGameOver ? 'MISSED ❌' : 'OVER LINE ⚠️'; }
              else if (diff <= 2) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = 'CLOSE'; }
              else { statStatus = 'safe'; statColor = '#34D399'; statLabel = 'ON PACE'; }
            }
          }

          const isLiveGame = live && live.gameStatus === 'in';
          const isDoneGame = live && live.gameStatus === 'post';

          return (
            <div key={i} onClick={() => toggleProp(p)} style={{
              background: faded ? 'rgba(249,115,22,0.12)' : 'rgba(139,92,246,0.12)',
              borderRadius: 12, marginBottom: 6, padding: '10px 12px',
              border: faded ? '2px solid rgba(249,115,22,0.4)' : '2px solid rgba(139,92,246,0.4)',
              boxShadow: isLiveGame ? '0 2px 16px rgba(139,92,246,0.25)' : '0 1px 6px rgba(0,0,0,0.2)',
              borderLeft: faded ? '5px solid #FB923C' : (live ? `5px solid ${statColor}` : '5px solid #A78BFA'),
              opacity: isDoneGame ? 0.7 : 1,
              cursor: 'pointer', transition: 'background 0.15s, opacity 0.3s',
            }}>
              {live && statStatus === 'close' && <div style={{ background: 'rgba(252,211,77,0.15)', color: '#FCD34D', fontSize: 10, fontWeight: 700, padding: '3px 10px', marginBottom: 6, marginLeft: -12, marginRight: -12, marginTop: -10, textAlign: 'center', borderRadius: '12px 12px 0 0' }}>🔥 CLOSE — {isOverBet ? `${(lineNum - live.current) % 1 === 0 ? (lineNum - live.current) : (lineNum - live.current).toFixed(1)} away` : 'approaching line'}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    {faded ? <span style={{ fontSize: 9, fontWeight: 700, color: '#FDBA74', background: 'rgba(249,115,22,0.25)', padding: '1px 5px', borderRadius: 3 }}>FADE</span>
                      : <span style={{ fontSize: 9, fontWeight: 700, color: '#C4B5FD', background: 'rgba(139,92,246,0.25)', padding: '1px 5px', borderRadius: 3 }}>MY BET</span>}
                    {live && <span style={{ width: isLiveGame ? 8 : 6, height: isLiveGame ? 8 : 6, borderRadius: '50%', background: isLiveGame ? '#34D399' : '#64748B', display: 'inline-block', boxShadow: isLiveGame ? '0 0 6px rgba(52,211,153,0.6)' : 'none', animation: isLiveGame ? 'pulse 2s infinite' : 'none' }} />}
                    {p.league && <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#F1F5F9', marginBottom: 1 }}>{p.player}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'capitalize' }}>{(p.market || '').replace(/_/g, ' ')}</div>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4,
                    background: isOver(p.direction) ? 'rgba(16,185,129,0.12)' : 'rgba(248,113,113,0.12)',
                    border: `1px solid ${isOver(p.direction) ? 'rgba(16,185,129,0.25)' : 'rgba(248,113,113,0.25)'}`,
                    padding: '3px 10px', borderRadius: 6,
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: dirColor, textTransform: 'uppercase' }}>{p.direction}</span>
                    <span style={{ fontSize: 15, fontWeight: 900, color: '#F1F5F9' }}>{p.line}</span>
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>{fmt(p.bookOdds)}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#64748B', marginTop: 1 }}>
                    <span>via {p.book}</span>
                    {p.edge && <span> · <span style={{ color: edgeColor, fontWeight: 700 }}>{p.edge}% edge</span></span>}
                    {p.selectedAt && <span> · <span style={{ color: (Date.now() - p.selectedAt) > 3600000 ? '#FBBF24' : '#64748B' }}>{timeAgo(p.selectedAt)}</span></span>}
                  </div>
                </div>
                {live ? (
                  <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0, minWidth: 55 }}>
                    <div style={{ fontSize: 26, fontWeight: 900, color: statColor, lineHeight: 1 }}>{live.current}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>/ {p.line}</div>
                    <div style={{ width: 46, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, margin: '3px auto', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(100, (live.current / (lineNum || 1)) * 100)}%`, background: statColor, borderRadius: 2, transition: 'width 0.3s' }} />
                    </div>
                    <div style={{ fontSize: 8, fontWeight: 700, color: statColor, marginTop: 1 }}>{statLabel}</div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#94A3B8' }}>{fmt(p.bookOdds)}</div>
                    <div style={{ fontSize: 9, color: '#64748B' }}>locked</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // Filter by date
  let filtered = props.filter(p => {
    if (propDateFilter === 'All') return true;
    const d = getPropDate(p);
    if (!d) return propDateFilter === 'Today'; // No date = assume today
    if (propDateFilter === 'Today') return d === todayStr;
    if (propDateFilter === 'Tomorrow') return d === tomorrowStr;
    return true;
  });

  // Filter by sport
  filtered = filtered.filter(p => {
    if (sf !== 'All' && sf !== 'Live' && p.league !== sf) return false;
    return true;
  });

  // Filter by sportsbook
  if (pf !== 'All') {
    filtered = filtered.filter(p => p.book === pf);
  }

  // Sort by edge descending (already sorted from backend, but enforce here)
  filtered.sort((a, b) => b.edge - a.edge);

  if (!filtered.length) return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>No prop edges found</div>;

  const isOver = (d) => (d || '').toLowerCase() === 'over';

  return (
    <>
      <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9' }}>Top Edges</div>
        <div style={{ fontSize: 11, color: '#64748B' }}>{filtered.length} props found</div>
      </div>
      {filtered.map((p, i) => {
        const edgeNum = parseFloat(p.edge) || 0;
        const edgeColor = edgeNum >= 8 ? '#34D399' : edgeNum >= 5 ? '#FBBF24' : '#64748B';
        const edgeBg = edgeNum >= 8 ? 'rgba(16,185,129,0.15)' : edgeNum >= 5 ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.08)';
        const dirColor = isOver(p.direction) ? '#34D399' : '#F87171';
        const selected = isPropBet(p);
        const faded = isPropFade(p);
        const live = liveStats[`prop|${p.league}|${p.player}|${p.market}|${p.direction}|${p.line}|${p.book}`] || null;
        const lineNum = parseFloat(p.line) || 0;
        const isOverBet = isOver(p.direction);

        // Live stat status
        let statStatus = null, statColor = '#64748B', statLabel = '';
        if (live) {
          const cur = live.current;
          const isGameOver = live.gameStatus === 'post';
          const diff = lineNum - cur;

          if (isOverBet) {
            if (cur >= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = isGameOver ? 'HIT ✅' : 'OVER ✅'; }
            else if (isGameOver) { statStatus = 'miss'; statColor = '#F87171'; statLabel = 'MISSED ❌'; }
            else if (diff <= 3) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
            else { statStatus = 'behind'; statColor = '#94A3B8'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
          } else {
            if (isGameOver && cur <= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = 'HIT ✅'; }
            else if (cur > lineNum) { statStatus = 'miss'; statColor = '#F87171'; statLabel = isGameOver ? 'MISSED ❌' : 'OVER LINE ⚠️'; }
            else if (diff <= 2) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = 'CLOSE'; }
            else { statStatus = 'safe'; statColor = '#34D399'; statLabel = 'ON PACE'; }
          }
        }

        const isLiveGame = live && live.gameStatus === 'in';
        const isDoneGame = live && live.gameStatus === 'post';

        return (
          <div key={i} onClick={() => toggleProp(p)} style={{
            background: faded ? 'rgba(249,115,22,0.12)' : selected ? (live && statStatus === 'close' ? 'rgba(252,211,77,0.08)' : 'rgba(139,92,246,0.12)') : 'rgba(255,255,255,0.04)',
            borderRadius: 12, marginBottom: 6, padding: '10px 12px',
            border: isDoneGame && !selected ? '1px solid rgba(255,255,255,0.06)' : faded ? '2px solid rgba(249,115,22,0.4)' : selected ? (live && statStatus === 'close' ? '2px solid rgba(252,211,77,0.3)' : '2px solid rgba(139,92,246,0.4)') : '1px solid rgba(255,255,255,0.08)',
            boxShadow: isLiveGame ? (faded ? '0 2px 16px rgba(249,115,22,0.25)' : selected ? '0 2px 16px rgba(139,92,246,0.25)' : '0 2px 12px rgba(0,0,0,0.4)') : '0 1px 6px rgba(0,0,0,0.2)',
            borderLeft: faded ? '5px solid #FB923C' : selected ? (live ? `5px solid ${statColor}` : '5px solid #A78BFA') : isDoneGame ? `4px solid ${statColor}` : `3px solid ${edgeColor}`,
            opacity: isDoneGame && !selected ? 0.65 : 1,
            cursor: 'pointer', transition: 'background 0.15s, border-left 0.15s, opacity 0.3s',
          }}>
            {live && statStatus === 'close' && <div style={{ background: 'rgba(252,211,77,0.15)', color: '#FCD34D', fontSize: 10, fontWeight: 700, padding: '3px 10px', marginBottom: 6, marginLeft: -12, marginRight: -12, marginTop: -10, textAlign: 'center', borderRadius: '12px 12px 0 0' }}>🔥 CLOSE — {isOverBet ? `${(lineNum - live.current) % 1 === 0 ? (lineNum - live.current) : (lineNum - live.current).toFixed(1)} away` : 'approaching line'}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  {faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#FDBA74', background: 'rgba(249,115,22,0.25)', padding: '1px 5px', borderRadius: 3 }}>FADE</span>}
                  {selected && !faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#C4B5FD', background: 'rgba(139,92,246,0.25)', padding: '1px 5px', borderRadius: 3 }}>MY BET</span>}
                  {live && <span style={{ width: isLiveGame ? 8 : 6, height: isLiveGame ? 8 : 6, borderRadius: '50%', background: isLiveGame ? '#34D399' : '#64748B', display: 'inline-block', boxShadow: isLiveGame ? '0 0 6px rgba(52,211,153,0.6)' : 'none', animation: isLiveGame ? 'pulse 2s infinite' : 'none' }} />}
                  {p.league && <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>}
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3 }}>{p.market}</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#F1F5F9', marginBottom: 1 }}>{p.player}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'capitalize', letterSpacing: 0.3 }}>{(p.market || '').replace(/_/g, ' ')}</div>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4,
                  background: isOver(p.direction) ? 'rgba(16,185,129,0.12)' : 'rgba(248,113,113,0.12)',
                  border: `1px solid ${isOver(p.direction) ? 'rgba(16,185,129,0.25)' : 'rgba(248,113,113,0.25)'}`,
                  padding: '3px 10px', borderRadius: 6,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: dirColor, textTransform: 'uppercase' }}>{p.direction}</span>
                  <span style={{ fontSize: 15, fontWeight: 900, color: '#F1F5F9' }}>{p.line}</span>
                  <span style={{ fontSize: 11, color: '#94A3B8' }}>{fmt(p.bookOdds)}</span>
                </div>
                <div style={{ fontSize: 10, color: '#94A3B8' }}>{p.game}{(() => {
                  const c = gameCommence[p.game];
                  if (!c) return null;
                  try {
                    const d = new Date(c);
                    const dateStr = d.toLocaleDateString('en-CA');
                    const isToday = dateStr === todayStr;
                    const isTmrw = dateStr === tomorrowStr;
                    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                    const label = isToday ? timeStr : isTmrw ? `Tomorrow ${timeStr}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${timeStr}`;
                    return <span style={{ color: '#64748B', marginLeft: 4 }}>· {label}</span>;
                  } catch { return null; }
                })()}</div>
                <div style={{ fontSize: 10, color: '#64748B', marginTop: 1, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span>via {p.book}</span>
                  {live ? (
                    <span>· <span style={{ color: edgeColor, fontWeight: 700 }}>{p.edge}% edge</span> · consensus {p.consensusProb}% vs book {p.bookProb}%</span>
                  ) : (
                    <span>· consensus {p.consensusProb}% vs book {p.bookProb}%</span>
                  )}
                </div>
              </div>
              {live ? (
                <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0, minWidth: 55 }}>
                  <div style={{ fontSize: 26, fontWeight: 900, color: statColor, lineHeight: 1 }}>{live.current}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>/ {p.line}</div>
                  <div style={{ width: 46, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, margin: '3px auto', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, (live.current / (lineNum || 1)) * 100)}%`, background: statColor, borderRadius: 2, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: 8, fontWeight: 700, color: statColor, marginTop: 1 }}>{statLabel}</div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: edgeColor }}>{p.edge}%</div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: edgeColor, background: edgeBg, padding: '2px 8px', borderRadius: 10 }}>EDGE</div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Model Changelog ────────────────────────────────────────────────
const MODEL_CHANGELOG = [
  { date: '2026-05-28', version: 'v2.5', title: 'Quick-Lock + Expanded Scores', changes: ['Morning Quick-Lock bulk selection for 0.2u+ picks', 'Period-by-period scoring and game leaders in Scores', 'My Bets filter on all tabs with cross-tab persistence', 'Model changelog in Results'] },
  { date: '2026-05-27', version: 'v2.4', title: 'MLB Pitchers + Progress Bars', changes: ['Starting pitcher + ERA display on MLB pick cards', 'Game progress bars on Scores cards', 'Pick status dots (flashing W/L indicators)', 'Doubleheader detection + Game 1/Game 2 labels', 'Settings tab with GitHub token + system review trigger'] },
  { date: '2026-05-26', version: 'v2.3', title: 'Prop Timing + Line Lock', changes: ['Selection timestamp on prop bets with staleness warning', 'Locked-in lines persist across line movements', 'My Bets section in Props tab'] },
  { date: '2026-05-25', version: 'v2.2', title: 'Visual Polish Pass', changes: ['Live vs completed game visual distinction', 'Game/Props toggle on Results tab', 'Prop date filter (Today/Tomorrow/All)'] },
  { date: '2026-05-24', version: 'v2.1', title: 'Fades + Cumulative Chart', changes: ['Three-state pick toggle: none → bet → fade', 'Faded picks flip to opposite side on Scores', 'Cumulative units chart on Results'] },
  { date: '2026-03-15', version: 'v2.0', title: 'Node.js Migration', changes: ['Migrated from Google Apps Script to Node.js + GitHub Actions', 'New Next.js web dashboard deployed on Vercel', 'ESPN live scores integration with 30s refresh'] },
];

function ChangelogTab() {
  return (
    <div>
      <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>🔧</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9' }}>Model Changelog</div>
          <div style={{ fontSize: 10, color: '#64748B' }}>Track what changed and when to correlate with performance</div>
        </div>
      </div>
      {MODEL_CHANGELOG.map((entry, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, marginBottom: 6, padding: '10px 12px', border: '1px solid rgba(255,255,255,0.08)', borderLeft: i === 0 ? '3px solid #F59E0B' : '3px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#F59E0B', background: 'rgba(245,158,11,0.15)', padding: '2px 6px', borderRadius: 4 }}>{entry.version}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#F1F5F9' }}>{entry.title}</span>
            </div>
            <span style={{ fontSize: 10, color: '#64748B', fontWeight: 600 }}>{entry.date}</span>
          </div>
          {entry.changes.map((c, ci) => (
            <div key={ci} style={{ fontSize: 11, color: '#94A3B8', paddingLeft: 8, marginTop: 2, display: 'flex', gap: 5 }}>
              <span style={{ color: '#475569' }}>·</span> {c}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Cumulative Units Chart ──────────────────────────────────────────
function UnitsChart({ results }) {
  // Build cumulative units by date (oldest first)
  const parseDate = (d) => {
    if (!d) return null;
    const parts = d.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  };

  const byDate = {};
  for (const r of results) {
    if (!byDate[r.date]) byDate[r.date] = 0;
    byDate[r.date] += (r.unitReturn || 0);
  }
  const sortedDates = Object.keys(byDate).sort((a, b) => {
    const da = parseDate(a), db = parseDate(b);
    return (da?.getTime() || 0) - (db?.getTime() || 0);
  });

  if (sortedDates.length < 2) return null;

  // Build cumulative data points
  let cum = 0;
  const points = sortedDates.map(d => { cum += byDate[d]; return { date: d, value: cum }; });

  const W = 340, H = 120, PAD_L = 35, PAD_R = 10, PAD_T = 10, PAD_B = 22;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const vals = points.map(p => p.value);
  const maxV = Math.max(...vals, 0.1);
  const minV = Math.min(...vals, -0.1);
  const range = maxV - minV || 1;

  const x = (i) => PAD_L + (i / (points.length - 1)) * chartW;
  const y = (v) => PAD_T + (1 - (v - minV) / range) * chartH;

  // SVG path
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  // Gradient fill path (area under curve to zero line)
  const zeroY = y(0);
  const areaD = `${pathD} L${x(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const current = points[points.length - 1].value;
  const lineColor = current >= 0 ? '#34D399' : '#F87171';
  const fillColor = current >= 0 ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)';

  // Date labels (show first, middle, last)
  const labelIdxs = [0, Math.floor(points.length / 2), points.length - 1];
  const fmtDate = (d) => {
    const parts = d.split('/');
    return `${parts[0]}/${parts[1]}`;
  };

  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '12px 10px', marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '0 4px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9' }}>Unit Progress</div>
        <div style={{ fontSize: 16, fontWeight: 900, color: lineColor }}>{current >= 0 ? '+' : ''}{current.toFixed(2)}u</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {/* Zero line */}
        <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="3,3" />
        {/* Y-axis labels */}
        <text x={PAD_L - 4} y={PAD_T + 4} fill="#64748B" fontSize="8" textAnchor="end">{maxV >= 0 ? '+' : ''}{maxV.toFixed(1)}</text>
        <text x={PAD_L - 4} y={zeroY + 3} fill="#64748B" fontSize="8" textAnchor="end">0</text>
        <text x={PAD_L - 4} y={H - PAD_B} fill="#64748B" fontSize="8" textAnchor="end">{minV.toFixed(1)}</text>
        {/* Fill area */}
        <path d={areaD} fill={fillColor} />
        {/* Line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* End dot */}
        <circle cx={x(points.length - 1)} cy={y(current)} r="3" fill={lineColor} />
        {/* Date labels */}
        {labelIdxs.map(i => (
          <text key={i} x={x(i)} y={H - 4} fill="#64748B" fontSize="8" textAnchor="middle">{fmtDate(points[i].date)}</text>
        ))}
      </svg>
    </div>
  );
}

// ── Results Tab ─────────────────────────────────────────────────────
function ResultsTab({ results, gradedProps, sf, bf, dateFilter, resultType, isBet, isPropBet }) {
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

  const dateMatch = (r) => {
    if (dateFilter === 'Today') return r.date === todayStr;
    if (dateFilter === 'Yesterday') return r.date === yesterdayStr;
    if (dateFilter === 'Last 7 Days') {
      const d = parseDate(r.date);
      return d && d >= weekAgo;
    }
    return true;
  };

  const showProps = resultType === 'Props';

  // Filter game results
  const filteredGames = showProps ? [] : results.filter(r => {
    if (sf === 'My Bets') return isBet(r);
    if (sf !== 'All' && r.league !== sf) return false;
    if (bf !== 'All' && (r.betType || r.market || '').toLowerCase() !== bf.toLowerCase()) return false;
    return dateMatch(r);
  });

  // Filter prop results
  const filteredProps = !showProps ? [] : (gradedProps || []).filter(r => {
    if (sf !== 'All' && sf !== 'My Bets' && r.league !== sf) return false;
    return dateMatch(r);
  });

  const filtered = showProps ? filteredProps : filteredGames;

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
      <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '12px 14px', marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, textAlign: 'center' }}>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: '#F1F5F9' }}>{wins}-{losses}{pushes ? `-${pushes}` : ''}</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>RECORD</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: '#F1F5F9' }}>{winPct}%</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>WIN %</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: totalReturn >= 0 ? '#34D399' : '#F87171' }}>{totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>UNITS</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: parseFloat(roi) >= 0 ? '#34D399' : '#F87171' }}>{roi}%</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>ROI</div></div>
      </div>
      {filtered.length >= 2 && <UnitsChart results={filtered} />}
      {!filtered.length && <div style={{ textAlign: 'center', color: '#64748B', padding: 30, fontSize: 13 }}>{showProps ? 'No graded prop results for this period' : 'No graded results for this period'}</div>}
      {sortedDates.map(date => {
        const bets = byDate[date];
        const dayReturn = bets.reduce((s, r) => s + (r.unitReturn || 0), 0);
        return (
          <div key={date} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 2px', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>{date}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: dayReturn >= 0 ? '#34D399' : '#F87171' }}>{dayReturn >= 0 ? '+' : ''}{dayReturn.toFixed(2)}u</span>
            </div>
            {showProps ? bets.map((r, j) => (
              <div key={j} style={{
                background: 'rgba(255,255,255,0.04)', borderRadius: 8, marginBottom: 3, padding: '8px 12px',
                border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between',
                borderLeft: `3px solid ${r.result === 'W' ? '#34D399' : '#F87171'}`
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 1 }}>
                    <span style={{ background: LEAGUE_COLORS[r.league], color: 'white', fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3 }}>{r.league}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>{r.market}</span>
                    {r.clvGrade && <span style={{ fontSize: 9, fontWeight: 700, color: r.clvGrade === 'HIT' ? '#34D399' : '#F87171', background: r.clvGrade === 'HIT' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)', padding: '1px 4px', borderRadius: 3 }}>CLV {r.clvGrade}</span>}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#F1F5F9' }}>{r.player}</div>
                  <div style={{ fontSize: 10, color: '#64748B' }}>{r.direction} {r.line} · {r.book}{r.edge ? ` · ${r.edge}% edge` : ''}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: r.result === 'W' ? '#34D399' : '#F87171' }}>{r.result}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: r.unitReturn >= 0 ? '#34D399' : '#F87171' }}>{r.unitReturn >= 0 ? '+' : ''}{(r.unitReturn || 0).toFixed(2)}u</div>
                </div>
              </div>
            )) : bets.map((r, j) => {
              const isMyBet = isBet(r);
              return (
              <div key={j} style={{
                background: isMyBet ? 'rgba(139,92,246,0.08)' : 'rgba(255,255,255,0.04)', borderRadius: 8, marginBottom: 3, padding: '8px 12px',
                border: isMyBet ? '1px solid rgba(139,92,246,0.2)' : '1px solid rgba(255,255,255,0.08)', boxShadow: isMyBet ? '0 2px 10px rgba(139,92,246,0.15)' : '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between',
                borderLeft: isMyBet ? '5px solid #A78BFA' : `3px solid ${r.result === 'W' ? '#34D399' : r.result === 'L' ? '#F87171' : '#64748B'}`
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 1 }}>
                    {isMyBet && <span style={{ fontSize: 8, fontWeight: 700, color: '#C4B5FD', background: 'rgba(139,92,246,0.25)', padding: '1px 4px', borderRadius: 3 }}>MY BET</span>}
                    <span style={{ background: LEAGUE_COLORS[r.league], color: 'white', fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3 }}>{r.league}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, textTransform: 'uppercase' }}>{r.betType || r.market}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#F1F5F9' }}>{r.pick} <span style={{ color: '#64748B', fontWeight: 400 }}>{fmt(r.odds)}</span></div>
                  <div style={{ fontSize: 10, color: '#64748B' }}>{r.away} @ {r.home}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: r.result === 'W' ? '#34D399' : r.result === 'L' ? '#F87171' : '#64748B' }}>{r.result}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: r.unitReturn >= 0 ? '#34D399' : '#F87171' }}>{r.unitReturn >= 0 ? '+' : ''}{(r.unitReturn || 0).toFixed(2)}u</div>
                </div>
              </div>
              );
            })}
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

        // Detect postponed/canceled/suspended
        const statusName = event.status?.type?.name || '';  // e.g. 'STATUS_POSTPONED', 'STATUS_CANCELED'
        const isPostponed = statusName.includes('POSTPONED') || statusName.includes('CANCELED') || statusName.includes('SUSPENDED');
        const statusDescription = event.status?.type?.description || '';
        
        // Doubleheader: ESPN uses notes to indicate Game 1/Game 2
        const notes = event.competitions?.[0]?.notes || [];
        const gameNote = notes.find(n => /game\s*[12]/i.test(n.headline || ''));
        const gameNum = gameNote ? (gameNote.headline.match(/game\s*(\d)/i)?.[1] || null) : null;

        // Extract probable pitchers for MLB pre-game
        let homePitcher = null, awayPitcher = null;
        if (league === 'MLB' && status === 'pre') {
          const extractPitcher = (team) => {
            const p = team?.probables?.[0];
            if (!p?.athlete) return null;
            const era = p.statistics?.find(s => s.name === 'ERA')?.displayValue;
            const w = p.statistics?.find(s => s.name === 'wins')?.displayValue;
            const l = p.statistics?.find(s => s.name === 'losses')?.displayValue;
            return { name: p.athlete.shortName, era: era || null, record: (w && l) ? `${w}-${l}` : null };
          };
          homePitcher = extractPitcher(homeTeam);
          awayPitcher = extractPitcher(awayTeam);
        }

        // Extract linescores (period-by-period scoring)
        const homeLinescores = (homeTeam?.linescores || []).map(l => l.value ?? 0);
        const awayLinescores = (awayTeam?.linescores || []).map(l => l.value ?? 0);

        // Extract leaders (top performers per category)
        const leaders = [];
        for (const team of [awayTeam, homeTeam]) {
          for (const cat of (team?.leaders || [])) {
            const top = cat.leaders?.[0];
            if (top) {
              leaders.push({
                category: cat.displayName || cat.name || '',
                shortCategory: cat.abbreviation || cat.name || '',
                athlete: top.athlete?.shortName || top.athlete?.displayName || '',
                value: top.displayValue || top.value || '',
                team: team?.team?.abbreviation || '',
              });
            }
          }
        }

        // Extract venue/broadcast
        const venue = comp.venue?.fullName || '';
        const broadcast = comp.broadcasts?.[0]?.names?.[0] || '';
        const odds = comp.odds?.[0]?.details || '';

        games.push({
          league,
          eventId: event.id,
          gameDate: event.date || comp.date || '',
          home: homeTeam?.team?.displayName || '',
          away: awayTeam?.team?.displayName || '',
          homeScore: parseInt(homeTeam?.score) || 0,
          awayScore: parseInt(awayTeam?.score) || 0,
          homeRecord: homeTeam?.records?.[0]?.summary || '',
          awayRecord: awayTeam?.records?.[0]?.summary || '',
          homeLinescores,
          awayLinescores,
          leaders,
          venue,
          broadcast,
          odds,
          status: isPostponed ? 'postponed' : status,
          statusDetail: isPostponed ? (statusDescription || statusName.replace('STATUS_', '')) : '',
          period,
          periodNum,
          clock,
          isLate,
          gameNum: gameNum ? parseInt(gameNum) : null,
          homePitcher,
          awayPitcher,
        });
      }
    } catch (e) { /* skip */ }
  }
  return games;
}

// ── Live Prop Stats (ESPN Box Scores) ───────────────────────────────
function extractStat(market, labels, stats) {
  const m = (market || '').toLowerCase().replace(/\s+/g, '_');
  const getStat = (label) => {
    const idx = labels.indexOf(label);
    if (idx === -1) return 0;
    const val = stats[idx];
    if (!val || val === '-' || val === '--') return 0;
    // Handle "made-attempted" format like "3-7" for 3PT, FG
    if (typeof val === 'string' && val.includes('-') && !val.startsWith('-') && !val.includes(':')) {
      return parseInt(val.split('-')[0]) || 0;
    }
    return parseFloat(val) || 0;
  };

  // Combo markets (check these first)
  if (m.includes('points') && m.includes('rebounds') && m.includes('assists')) return getStat('PTS') + getStat('REB') + getStat('AST');
  if (m.includes('points') && m.includes('rebounds')) return getStat('PTS') + getStat('REB');
  if (m.includes('points') && m.includes('assists')) return getStat('PTS') + getStat('AST');
  if (m.includes('rebounds') && m.includes('assists')) return getStat('REB') + getStat('AST');
  // Single stat markets
  if (m.includes('points') || m.includes('pts')) return getStat('PTS');
  if (m.includes('rebounds') || m.includes('reb')) return getStat('REB');
  if (m.includes('assists') || m.includes('ast')) return getStat('AST') || getStat('A');
  if (m.includes('threes') || m.includes('three') || m.includes('3pt')) return getStat('3PT');
  if (m.includes('steals')) return getStat('STL');
  if (m.includes('blocks') || m.includes('blk')) return getStat('BLK');
  if (m.includes('turnovers')) return getStat('TO');
  if (m.includes('hits') || m === 'batter_hits') return getStat('H');
  if (m.includes('total_bases')) return getStat('TB');
  if (m.includes('home_runs') || m.includes('hr')) return getStat('HR');
  if (m.includes('rbis') || m.includes('rbi')) return getStat('RBI');
  if (m.includes('strikeouts') || m === 'pitcher_strikeouts') return getStat('K') || getStat('SO');
  if (m.includes('goals')) return getStat('G');
  if (m.includes('shots_on_goal') || m.includes('sog')) return getStat('SOG') || getStat('S');
  if (m.includes('saves')) return getStat('SV');
  return null;
}

async function fetchBoxScore(eventId, sport, leagueKey) {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${leagueKey}/summary?event=${eventId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const players = {};
    const boxPlayers = data?.boxscore?.players || [];
    for (const team of boxPlayers) {
      for (const statGroup of (team.statistics || [])) {
        const labels = statGroup.labels || [];
        for (const athlete of (statGroup.athletes || [])) {
          const name = athlete.athlete?.displayName || '';
          const shortName = athlete.athlete?.shortName || '';
          const statVals = athlete.stats || [];
          if (name && labels.length) {
            const entry = { labels, stats: statVals, name };
            players[name.toLowerCase()] = entry;
            if (shortName) players[shortName.toLowerCase()] = entry;
            // Last name for fuzzy matching
            const parts = name.split(' ');
            if (parts.length > 1) {
              const last = parts.slice(-1)[0].toLowerCase();
              if (!players[last]) players[last] = entry;
            }
          }
        }
      }
    }
    return players;
  } catch (e) { return null; }
}

function matchPropToGame(prop, liveGames) {
  const gameStr = (prop.game || '').toLowerCase();
  return liveGames.find(g => {
    if (g.league !== prop.league) return false;
    const homeShort = g.home.split(' ').pop().toLowerCase();
    const awayShort = g.away.split(' ').pop().toLowerCase();
    return gameStr.includes(homeShort) && gameStr.includes(awayShort);
  });
}

function findPlayerStat(playerName, market, boxPlayers) {
  if (!boxPlayers || !playerName) return null;
  const name = playerName.toLowerCase().trim();
  // Try exact, then short name, then last name
  let found = boxPlayers[name];
  if (!found) {
    const lastName = name.split(' ').pop();
    found = boxPlayers[lastName];
    if (!found) {
      // Partial match
      for (const [key, val] of Object.entries(boxPlayers)) {
        if (key.includes(name) || name.includes(key)) { found = val; break; }
      }
    }
  }
  if (!found) return null;
  const val = extractStat(market, found.labels, found.stats);
  return val !== null ? { current: val, playerFound: found.name } : null;
}

// ── Main App ────────────────────────────────────────────────────────
// ── Settings Tab ──────────────────────────────────────────────────────
function SettingsTab() {
  const [confirmReview, setConfirmReview] = useState(false);
  const [reviewStatus, setReviewStatus] = useState(null);
  const [ghToken, setGhToken] = useState(() => {
    try { return (typeof window !== "undefined" && localStorage.getItem("shadowbets_gh_token")) || ""; } catch { return ""; }
  });
  const [tokenSaved, setTokenSaved] = useState(() => {
    try { return !!(typeof window !== "undefined" && localStorage.getItem("shadowbets_gh_token")); } catch { return false; }
  });

  const saveToken = () => {
    if (ghToken.startsWith("ghp_")) {
      try { localStorage.setItem("shadowbets_gh_token", ghToken); } catch {}
      setTokenSaved(true);
    }
  };

  const clearToken = () => {
    try { localStorage.removeItem("shadowbets_gh_token"); } catch {}
    setGhToken("");
    setTokenSaved(false);
  };

  const triggerSystemCheck = async () => {
    if (!ghToken) { setReviewStatus("error"); return; }
    setReviewStatus("sending");
    try {
      const resp = await fetch(
        "https://api.github.com/repos/nickciesinski/ShadowB/actions/workflows/system-check.yml/dispatches",
        { method: "POST", headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" }, body: JSON.stringify({ ref: "main" }) }
      );
      if (resp.status === 204 || resp.ok) { setReviewStatus("sent"); setConfirmReview(false); }
      else { setReviewStatus("error"); }
    } catch { setReviewStatus("error"); }
  };

  const cardStyle = { background: "rgba(255,255,255,0.04)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10, overflow: "hidden" };

  return (
    <div>
      {/* GitHub Token */}
      {!tokenSaved && (
        <div style={cardStyle}>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", marginBottom: 6 }}>Connect GitHub</div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 10 }}>Enter your PAT to enable workflow triggers.</div>
            <input
              type="password"
              placeholder="ghp_..."
              value={ghToken}
              onChange={e => setGhToken(e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.06)", color: "#F1F5F9", fontSize: 14, fontFamily: "monospace", marginBottom: 8, boxSizing: "border-box", outline: "none" }}
            />
            <button onClick={saveToken} disabled={!ghToken.startsWith("ghp_")} style={{ width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: ghToken.startsWith("ghp_") ? "#10B981" : "rgba(255,255,255,0.06)", color: ghToken.startsWith("ghp_") ? "white" : "#475569", fontSize: 14, fontWeight: 700, cursor: ghToken.startsWith("ghp_") ? "pointer" : "default" }}>Save Token</button>
          </div>
        </div>
      )}
      {tokenSaved && (
        <div style={{ background: "rgba(16,185,129,0.1)", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12, color: "#34D399", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <span>✓</span> GitHub connected
          <button onClick={clearToken} style={{ marginLeft: "auto", background: "none", border: "none", color: "#64748B", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>Reset</button>
        </div>
      )}

      {/* Section Label */}
      <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", padding: "10px 2px 6px", letterSpacing: 1 }}>Actions</div>

      {/* System Review */}
      <div style={cardStyle}>
        <button onClick={() => { if (reviewStatus === "sent") { setReviewStatus(null); return; } setConfirmReview(true); }} disabled={!tokenSaved || reviewStatus === "sending"} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "none", border: "none", cursor: tokenSaved ? "pointer" : "default", opacity: tokenSaved ? 1 : 0.4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(139,92,246,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🔍</span>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#F1F5F9" }}>System Review</div>
              <div style={{ fontSize: 12, color: "#64748B" }}>Health check + performance report via email</div>
            </div>
          </div>
          <div>
            {reviewStatus === "sending" && <span style={{ fontSize: 12, color: "#64748B" }}>Sending...</span>}
            {reviewStatus === "sent" && <span style={{ fontSize: 12, color: "#34D399", fontWeight: 600 }}>✓ Queued</span>}
            {reviewStatus === "error" && <span style={{ fontSize: 12, color: "#F87171" }}>Failed</span>}
            {!reviewStatus && <span style={{ color: "#334155", fontSize: 18 }}>›</span>}
          </div>
        </button>
        {confirmReview && (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "12px 16px", background: "rgba(255,255,255,0.02)" }}>
            <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 10 }}>Run a full system health check and email a performance report (3/7/15/30-day windows)?</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmReview(false)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#94A3B8", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={triggerSystemCheck} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "#8B5CF6", color: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Send Review</button>
            </div>
          </div>
        )}
      </div>

      {/* System Info */}
      <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", padding: "14px 2px 6px", letterSpacing: 1 }}>System</div>
      <div style={cardStyle}>
        <div style={{ padding: "4px 16px" }}>
          {[{ l: "Runtime", v: "GitHub Actions · Node 22" }, { l: "Data", v: "Google Sheets · 47 tabs" }, { l: "Compute", v: "Supabase (Postgres)" }, { l: "Triggers", v: "17 workflows" }, { l: "Model", v: "Deterministic + 6-factor props" }].map((item, i, arr) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
              <span style={{ fontSize: 13, color: "#64748B" }}>{item.l}</span>
              <span style={{ fontSize: 13, color: "#E2E8F0", fontWeight: 600 }}>{item.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  const [pf, setPf] = useState('All');
  const [dateFilter, setDateFilter] = useState('Last 7 Days');
  // My Bets — persisted to localStorage, auto-resets daily
  // Map<key, 'bet' | 'fade'> — 'bet' = tailed the pick, 'fade' = bet the opposite
  const [myBets, setMyBets] = useState(() => {
    try {
      const saved = typeof window !== 'undefined' && localStorage.getItem('shadowbets_mybets');
      if (saved) {
        const { date, bets } = JSON.parse(saved);
        const today = new Date().toLocaleDateString();
        if (date === today) {
          // Support old Set format (array of strings) and new Map format (array of [key, val])
          if (Array.isArray(bets) && bets.length > 0 && Array.isArray(bets[0])) {
            return new Map(bets);
          }
          // Legacy: convert old Set to Map (all as 'bet')
          return new Map(bets.map(k => [k, 'bet']));
        }
      }
    } catch (e) {}
    return new Map();
  });
  const [propDateFilter, setPropDateFilter] = useState('Today');
  const [resultType, setResultType] = useState('Games');
  const [data, setData] = useState(null);
  const [liveGames, setLiveGames] = useState([]);
  const [liveStats, setLiveStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Persist myBets to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem('shadowbets_mybets', JSON.stringify({
        date: new Date().toLocaleDateString(),
        bets: [...myBets.entries()],
      }));
    } catch (e) {}
  }, [myBets]);

  // Pick key for "my bets" selection
  const pickKey = (p) => `${p.league}|${p.away}|${p.home}|${(p.betType||p.market||'').toLowerCase()}|${p.pick}|${p.line}`;
  const propKey = (p) => `prop|${p.league}|${p.player}|${p.market}|${p.direction}|${p.book}`;
  // Three-state toggle: none → bet → fade → none
  const toggleBet = (p) => {
    const key = pickKey(p);
    setMyBets(prev => {
      const next = new Map(prev);
      const cur = next.get(key);
      if (!cur) next.set(key, 'bet');
      else if (cur === 'bet') next.set(key, 'fade');
      else next.delete(key);
      return next;
    });
  };
  const toggleProp = (p) => {
    const key = propKey(p);
    setMyBets(prev => {
      const next = new Map(prev);
      const cur = next.get(key);
      const curState = typeof cur === 'object' ? cur.state : cur;
      if (!curState) next.set(key, { state: 'bet', line: p.line, odds: p.bookOdds, player: p.player, league: p.league, market: p.market, direction: p.direction, book: p.book, game: p.game, selectedAt: Date.now() });
      else if (curState === 'bet') next.set(key, { state: 'fade', line: (typeof cur === 'object' ? cur.line : p.line), odds: (typeof cur === 'object' ? cur.odds : p.bookOdds), player: p.player, league: p.league, market: p.market, direction: p.direction, book: p.book, game: p.game, selectedAt: (typeof cur === 'object' ? cur.selectedAt : Date.now()) });
      else next.delete(key);
      return next;
    });
  };
  const isBet = (p) => myBets.has(pickKey(p));
  const isFade = (p) => myBets.get(pickKey(p)) === 'fade';
  const isPropBet = (p) => {
    const v = myBets.get(propKey(p));
    return !!v;
  };
  const isPropFade = (p) => {
    const v = myBets.get(propKey(p));
    return (typeof v === 'object' ? v.state : v) === 'fade';
  };
  // Get all stored prop bets for "My Bets" view
  // Lock all picks above threshold (for morning quick-lock)
  const lockAll = useCallback(() => {
    if (!data?.todayPicks) return;
    const qualified = dedup(data.todayPicks).filter(p => p.units >= 0.2);
    setMyBets(prev => {
      const next = new Map(prev);
      for (const p of qualified) {
        const key = pickKey(p);
        if (!next.has(key)) next.set(key, 'bet');
      }
      return next;
    });
  }, [data?.todayPicks]);

  const getMyPropBets = () => {
    const result = [];
    for (const [key, val] of myBets.entries()) {
      if (!key.startsWith('prop|')) continue;
      const obj = typeof val === 'object' ? val : { state: val };
      if (obj.player) result.push({ ...obj, _key: key });
    }
    return result;
  };

  // Fetch sheet data
  const fetchData = useCallback(() => {
    fetch('/api/data')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); setLastUpdated(new Date()); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Re-fetch data when app becomes visible (switching back to tab/app)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchData(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchData]);

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

  // Fetch box scores for ALL props with live/finished games (every 30s)
  useEffect(() => {
    if (!data?.props || !liveGames.length) return;

    const fetchStats = async () => {
      // Only consider games from today (prevents stale yesterday stats)
      const todayDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
      const isToday = (g) => {
        if (!g.gameDate) return g.status === 'in'; // no date = only trust live games
        try { return new Date(g.gameDate).toLocaleDateString('en-CA') === todayDate; }
        catch { return false; }
      };

      // Find unique live/post games that have props AND are from today
      const gameMap = new Map();
      for (const prop of data.props) {
        const game = matchPropToGame(prop, liveGames);
        if (game && game.eventId && (game.status === 'in' || game.status === 'post') && isToday(game)) {
          const cfg = ESPN_SPORTS[game.league];
          if (cfg && !gameMap.has(game.eventId)) {
            gameMap.set(game.eventId, { sport: cfg.key, leagueKey: cfg.league, game });
          }
        }
      }

      if (!gameMap.size) return;

      // Fetch all box scores in parallel
      const boxScores = {};
      const entries = [...gameMap.entries()];
      const results = await Promise.all(entries.map(([eid, { sport, leagueKey }]) => fetchBoxScore(eid, sport, leagueKey)));
      entries.forEach(([eid], i) => { if (results[i]) boxScores[eid] = results[i]; });

      // Extract stats for ALL props
      const newStats = {};
      for (const prop of data.props) {
        const game = matchPropToGame(prop, liveGames);
        if (!game || !game.eventId || !boxScores[game.eventId]) continue;
        const result = findPlayerStat(prop.player, prop.market, boxScores[game.eventId]);
        if (result !== null) {
          const key = propKey(prop);
          newStats[key] = { current: result.current, gameStatus: game.status, period: game.period, clock: game.clock };
        }
      }
      setLiveStats(newStats);
    };

    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, [data?.props, liveGames]);

  const liveCount = liveGames.filter(g => g.status === 'in').length;
  const closeCount = liveGames.filter(g => g.status === 'in' && g.isLate && Math.abs(g.awayScore - g.homeScore) <= 5).length;

  const betCount = myBets.size;
  const fadeCount = [...myBets.values()].filter(v => v === 'fade').length;
  // Only show leagues that have real games today (hides off-season leagues like NFL in April)
  const todayDateISO = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  const realGames = liveGames.filter(g => {
    if (g.status === 'in') return true; // live = real
    if (!g.gameDate) return false;
    try { return new Date(g.gameDate).toLocaleDateString('en-CA') === todayDateISO; }
    catch { return false; }
  });
  const activeLeagues = [...new Set(realGames.map(g => g.league))];
  const activeLeaguePills = ['NBA', 'NHL', 'MLB', 'NFL'].filter(l => activeLeagues.includes(l));
  // For picks/props, also include leagues from data even if no ESPN games yet
  const dataLeagues = data ? [...new Set([
    ...(data.todayPicks || []).map(p => p.league),
    ...(data.props || []).map(p => p.league),
  ])].filter(Boolean) : [];
  const allActiveLeagues = [...new Set([...activeLeaguePills, ...dataLeagues])].filter(l => ['NBA', 'NHL', 'MLB', 'NFL'].includes(l));

  const propBetCount = [...myBets.entries()].filter(([k]) => k.startsWith('prop|')).length;
  const sportPills = tab === 'scores'
    ? (betCount > 0 ? ['All', 'My Bets', 'Live', ...activeLeaguePills] : ['All', 'Live', ...activeLeaguePills])
    : tab === 'props'
    ? (propBetCount > 0 ? ['All', 'My Bets', ...allActiveLeagues] : ['All', ...allActiveLeagues])
    : tab === 'results'
    ? (betCount > 0 ? ['All', 'My Bets', ...allActiveLeagues] : ['All', ...allActiveLeagues])
    : (betCount > 0 ? ['All', 'My Bets', ...allActiveLeagues] : ['All', ...allActiveLeagues]);

  // When switching tabs, keep "My Bets" filter if the new tab supports it
  const handleTabChange = (newTab) => {
    setTab(newTab);
    if (sf === 'My Bets') {
      const hasBetsForTab = newTab === 'props' ? propBetCount > 0 : betCount > 0;
      if (!hasBetsForTab) setSf('All');
    } else if (sf === 'Live' && newTab !== 'scores') {
      setSf('All');
    }
  };

  const tabs = [
    { id: 'picks', label: 'Picks', icon: '📋' },
    { id: 'scores', label: 'Scores', icon: '🏟️' },
    { id: 'props', label: 'Props', icon: '🎯' },
    { id: 'results', label: 'Results', icon: '📊' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', background: '#0B0F1A', minHeight: '100vh', position: 'relative' }}>
      {/* Header */}
      <div style={{ background: '#0B0F1A', padding: '12px 14px 6px', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: '#F1F5F9', letterSpacing: -0.5 }}>Shadow Bets</span>
            {liveCount > 0 && (
              <span style={{ fontSize: 9, color: '#34D399', fontWeight: 600, background: 'rgba(52,211,153,0.15)', padding: '2px 7px', borderRadius: 10 }}>
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
            <div style={{ fontSize: 11, color: '#94A3B8' }}>{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            {lastUpdated && <div style={{ fontSize: 9, color: '#64748B' }}>Updated {lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>}
          </div>
        </div>
        {tab !== 'settings' && <Pills items={sportPills} active={sf} onChange={setSf} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'picks' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'picks' && <Pills items={CONFIDENCE_FILTERS} active={cf} onChange={setCf} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'props' && <Pills items={['Today', 'Tomorrow', 'All']} active={propDateFilter} onChange={setPropDateFilter} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'props' && (() => {
          const books = data?.props ? ['All', ...new Set(data.props.map(p => p.book).filter(Boolean))] : ['All'];
          return <Pills items={books} active={pf} onChange={setPf} color={TAB_ACCENTS[tab].accent} />;
        })()}
        {tab === 'scores' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'results' && <Pills items={['Games', 'Props', 'Changelog']} active={resultType} onChange={setResultType} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'results' && resultType === 'Games' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color={TAB_ACCENTS[tab].accent} />}
        {tab === 'results' && resultType !== 'Changelog' && <Pills items={DATE_FILTERS} active={dateFilter} onChange={setDateFilter} color={TAB_ACCENTS[tab].accent} />}
      </div>
      {/* Tab accent gradient strip */}
      <div style={{ height: 3, background: TAB_ACCENTS[tab].gradient, position: 'sticky', top: 'var(--header-height, 0)', zIndex: 19, animation: 'shimmer 2s ease-in-out infinite' }} />

      {/* Animations */}
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
        @keyframes shimmer { 0% { opacity: 0.7; } 50% { opacity: 1; } 100% { opacity: 0.7; } }
      `}</style>

      {/* Content */}
      <div style={{ padding: '8px 12px 90px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 60, color: '#64748B' }}>Loading...</div>}
        {error && <div style={{ textAlign: 'center', padding: 40, color: '#F87171', fontSize: 13 }}>Error: {error}<br /><span style={{ fontSize: 11, color: '#64748B' }}>Check Vercel env vars</span></div>}
        {data && tab === 'picks' && <PicksTab picks={data.todayPicks} sf={sf} bf={bf} cf={cf} isBet={isBet} isFade={isFade} toggleBet={toggleBet} liveGames={liveGames} lockAll={lockAll} />}
        {data && tab === 'scores' && <ScoresTab liveGames={liveGames.filter(g => {
          // Hide off-season games (e.g. Super Bowl replay in April)
          if (g.status === 'in') return true;
          if (!g.gameDate) return false;
          try { return new Date(g.gameDate).toLocaleDateString('en-CA') === todayDateISO; }
          catch { return false; }
        })} picks={data.todayPicks} sf={sf} bf={bf} isBet={isBet} isFade={isFade} />}
        {data && tab === 'props' && <PropsTab props={data.props} todayGames={data.todayGames} sf={sf} pf={pf} propDateFilter={propDateFilter} isPropBet={isPropBet} isPropFade={isPropFade} toggleProp={toggleProp} liveStats={liveStats} myPropBets={getMyPropBets()} />}
        {data && tab === 'results' && resultType === 'Changelog' && <ChangelogTab />}
        {data && tab === 'results' && resultType !== 'Changelog' && <ResultsTab results={data.gradedPicks} gradedProps={data.gradedProps || []} sf={sf} bf={bf} dateFilter={dateFilter} resultType={resultType} isBet={isBet} isPropBet={isPropBet} />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      {/* Tab Bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: '100%', maxWidth: 480, background: '#0B0F1A', borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', justifyContent: 'space-around',
        padding: '8px 0 env(safe-area-inset-bottom, 10px)', zIndex: 30,
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => handleTabChange(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            padding: '6px 20px', color: tab === t.id ? TAB_ACCENTS[t.id].accent : '#475569',
            position: 'relative', minHeight: 44,
          }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{ fontSize: 11, fontWeight: 700, borderBottom: tab === t.id ? `2px solid ${TAB_ACCENTS[t.id].accent}` : '2px solid transparent', paddingBottom: 1 }}>{t.label}</span>
            {tab === t.id && <span style={{ position: 'absolute', bottom: -4, width: '90%', height: 8, borderRadius: 4, boxShadow: `0 -2px 10px ${TAB_ACCENTS[t.id].glow}` }} />}
            {t.id === 'scores' && closeCount > 0 && (
              <span style={{ position: 'absolute', top: 0, right: 8, background: '#F59E0B', color: 'white', fontSize: 8, fontWeight: 800, width: 14, height: 14, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{closeCount}</span>
            )}
            {t.id === 'scores' && betCount > 0 && closeCount === 0 && (
              <span style={{ position: 'absolute', top: 0, right: 8, background: '#8B5CF6', color: 'white', fontSize: 8, fontWeight: 800, width: 14, height: 14, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{betCount}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
