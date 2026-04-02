'use client';
import { useState, useEffect, useCallback } from 'react';

// ── Constants ───────────────────────────────────────────────────────
const SPORTS = ['All', 'NBA', 'NHL', 'MLB', 'NFL'];
const BET_TYPES = ['All', 'Spread', 'Moneyline', 'Total'];
const LEAGUE_COLORS = { NBA: '#C9082A', NHL: '#000', MLB: '#002D72', NFL: '#013369' };
const LEAGUE_BG = { NBA: '#FEF2F2', NHL: '#F3F4F6', MLB: '#EFF6FF', NFL: '#EEF2FF' };

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

function getPickStatus(pick, game) {
  if (!game || !game.awayScore && game.awayScore !== 0) return 'pending';
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
  if (!picks.length || !game) return 0;
  let score = 0;
  for (const p of picks) {
    const s = getPickStatus(p, game);
    score += s === 'winning' ? 1 : s === 'losing' ? -1 : 0;
  }
  return score / picks.length;
}

// ── Filter Pills ────────────────────────────────────────────────────
function Pills({ items, active, onChange, color = '#1F2937' }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '6px 0', WebkitOverflowScrolling: 'touch' }}>
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

// ── Picks Tab ───────────────────────────────────────────────────────
function PicksTab({ picks, sf, bf }) {
  const filtered = picks.filter(p =>
    (sf === 'All' || p.league === sf) &&
    (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase())
  );
  const games = {};
  for (const p of filtered) {
    const k = `${p.away}@${p.home}`;
    if (!games[k]) games[k] = { ...p, picks: [] };
    games[k].picks.push(p);
  }

  if (!Object.keys(games).length) return <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 40, fontSize: 14 }}>No picks match filters</div>;

  return Object.values(games).map((g, i) => (
    <div key={i} style={{ background: 'white', borderRadius: 12, marginBottom: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: LEAGUE_BG[g.league] || '#F9FAFB', borderBottom: '1px solid #F3F4F6' }}>
        <span style={{ background: LEAGUE_COLORS[g.league] || '#6B7280', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{g.league}</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{g.away} @ {g.home}</span>
      </div>
      {g.picks.map((p, j) => (
        <div key={j} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: j < g.picks.length - 1 ? '1px solid #F9FAFB' : 'none' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', padding: '1px 5px', borderRadius: 3, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{p.pick}</span>
            </div>
            <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.rationale || ''}</div>
          </div>
          <div style={{ textAlign: 'right', marginLeft: 10, flexShrink: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{fmt(p.odds)}</div>
            <div style={{ fontSize: 11, color: '#6B7280' }}>{p.units}u</div>
            <span style={{ fontSize: 10, fontWeight: 700, color: confColor(p.confidence), background: confBg(p.confidence), padding: '1px 5px', borderRadius: 10 }}>{String(p.confidence).replace('%', '')}</span>
          </div>
        </div>
      ))}
    </div>
  ));
}

// ── Scores Tab ──────────────────────────────────────────────────────
function ScoresTab({ liveGames, picks, sf, bf }) {
  const [expanded, setExpanded] = useState({});
  const filtered = liveGames.filter(g => sf === 'All' || g.league === sf);

  return filtered.length === 0
    ? <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 40, fontSize: 14 }}>No live games right now</div>
    : filtered.map((game, i) => {
      const gamePicks = picks.filter(p =>
        p.league === game.league && p.away === game.away && p.home === game.home &&
        (bf === 'All' || (p.betType || p.market || '').toLowerCase() === bf.toLowerCase())
      );
      const trend = getTrend(gamePicks, game);
      const tBorder = trend > 0.3 ? '#059669' : trend < -0.3 ? '#DC2626' : '#E5E7EB';
      const tBg = trend > 0.3 ? 'rgba(5,150,105,0.06)' : trend < -0.3 ? 'rgba(220,38,38,0.05)' : 'transparent';
      const diff = Math.abs(game.awayScore - game.homeScore);
      const isClose = game.isLate && diff <= 5;
      const isExp = expanded[i];

      return (
        <div key={i} style={{ background: 'white', borderRadius: 12, marginBottom: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `2px solid ${tBorder}` }}>
          {isClose && <div style={{ background: '#FEF3C7', color: '#92400E', fontSize: 11, fontWeight: 700, padding: '3px 12px' }}>CLOSE GAME — Tune in!</div>}
          <div onClick={() => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))} style={{ padding: '10px 12px', cursor: 'pointer', background: tBg }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ background: LEAGUE_COLORS[game.league], color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>{game.league}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: trend > 0.3 ? '#059669' : trend < -0.3 ? '#DC2626' : '#9CA3AF' }}>
                  {trend > 0.3 ? 'Picks trending well' : trend < -0.3 ? 'Picks struggling' : 'Even'}
                </span>
              </div>
              <span style={{ fontSize: 11, color: '#6B7280' }}>{game.period} {game.clock || ''}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ textAlign: 'right', flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{game.away}</div>
              </div>
              <span style={{ fontSize: 26, fontWeight: 800, color: game.awayScore >= game.homeScore ? '#111827' : '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>{game.awayScore}</span>
              <span style={{ fontSize: 14, color: '#D1D5DB' }}>-</span>
              <span style={{ fontSize: 26, fontWeight: 800, color: game.homeScore >= game.awayScore ? '#111827' : '#9CA3AF', fontVariantNumeric: 'tabular-nums' }}>{game.homeScore}</span>
              <div style={{ textAlign: 'left', flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{game.home}</div>
              </div>
            </div>
            <div style={{ textAlign: 'center', fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>{isExp ? '▲ Hide picks' : `▼ ${gamePicks.length} picks`}</div>
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
  const filtered = props.filter(p => sf === 'All' || p.sport === sf);
  if (!filtered.length) return <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 40, fontSize: 14 }}>No props available</div>;

  return filtered.map((p, i) => (
    <div key={i} style={{ background: 'white', borderRadius: 12, marginBottom: 6, padding: '10px 12px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', justifyContent: 'space-between' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
          <span style={{ background: LEAGUE_COLORS[p.sport] || '#6B7280', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.sport}</span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{p.player}</span>
        </div>
        <div style={{ fontSize: 11, color: '#4B5563' }}>{(p.market || '').replace(/^(player_|pitcher_|batter_)/, '').replace(/_/g, ' ')}</div>
        <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.rationale}</div>
      </div>
      <div style={{ textAlign: 'center', marginLeft: 10, flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: p.pick === 'over' ? '#059669' : '#DC2626', textTransform: 'uppercase' }}>{p.pick}</div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>{p.line}</div>
        <span style={{ fontSize: 10, fontWeight: 700, color: confColor(p.confidence), background: confBg(p.confidence), padding: '1px 5px', borderRadius: 10 }}>{p.confidence}/10</span>
      </div>
    </div>
  ));
}

// ── Results Tab ─────────────────────────────────────────────────────
function ResultsTab({ results, sf, bf }) {
  const filtered = results.filter(r =>
    (sf === 'All' || r.league === sf) &&
    (bf === 'All' || (r.betType || r.market || '').toLowerCase() === bf.toLowerCase())
  );
  const wins = filtered.filter(r => r.result === 'W').length;
  const losses = filtered.filter(r => r.result === 'L').length;
  const pushes = filtered.filter(r => r.result === 'P').length;
  const totalReturn = filtered.reduce((s, r) => s + (r.unitReturn || 0), 0);
  const totalWagered = filtered.reduce((s, r) => s + (r.units || 0), 0);
  const winPct = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0';
  const roi = totalWagered > 0 ? ((totalReturn / totalWagered) * 100).toFixed(1) : '0';

  const byDate = {};
  for (const r of filtered) { if (!byDate[r.date]) byDate[r.date] = []; byDate[r.date].push(r); }

  return (
    <>
      <div style={{ background: 'white', borderRadius: 12, padding: '12px 14px', marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, textAlign: 'center' }}>
        <div><div style={{ fontSize: 18, fontWeight: 800 }}>{wins}-{losses}{pushes ? `-${pushes}` : ''}</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>RECORD</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800 }}>{winPct}%</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>WIN %</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: totalReturn >= 0 ? '#059669' : '#DC2626' }}>{totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>UNITS</div></div>
        <div><div style={{ fontSize: 18, fontWeight: 800, color: parseFloat(roi) >= 0 ? '#059669' : '#DC2626' }}>{roi}%</div><div style={{ fontSize: 9, color: '#9CA3AF', fontWeight: 600 }}>ROI</div></div>
      </div>
      {Object.entries(byDate).map(([date, bets]) => {
        const dayReturn = bets.reduce((s, r) => s + (r.unitReturn || 0), 0);
        return (
          <div key={date} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 2px', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{date}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: dayReturn >= 0 ? '#059669' : '#DC2626' }}>{dayReturn >= 0 ? '+' : ''}{dayReturn.toFixed(3)}u</span>
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
                  <div style={{ fontSize: 11, fontWeight: 600, color: r.unitReturn >= 0 ? '#059669' : '#DC2626' }}>{r.unitReturn >= 0 ? '+' : ''}{(r.unitReturn || 0).toFixed(3)}u</div>
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
        const status = event.status?.type?.state; // pre, in, post
        const period = event.status?.type?.shortDetail || '';
        const clock = event.status?.displayClock || '';
        const periodNum = event.status?.period || 0;

        // Determine if late in game
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
  const [tab, setTab] = useState('scores');
  const [sf, setSf] = useState('All');
  const [bf, setBf] = useState('All');
  const [data, setData] = useState(null);
  const [liveGames, setLiveGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch sheet data
  useEffect(() => {
    fetch('/api/data')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  // Fetch live scores every 30s
  const refreshScores = useCallback(async () => {
    const scores = await fetchLiveScores();
    setLiveGames(scores);
  }, []);

  useEffect(() => {
    refreshScores();
    const interval = setInterval(refreshScores, 30000);
    return () => clearInterval(interval);
  }, [refreshScores]);

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 17, fontWeight: 800, color: 'white', letterSpacing: -0.5 }}>Shadow Bets</span>
            {liveGames.some(g => g.status === 'in') && (
              <span style={{ fontSize: 9, color: '#6EE7B7', fontWeight: 600, background: 'rgba(110,231,183,0.15)', padding: '2px 7px', borderRadius: 10 }}>LIVE</span>
            )}
          </div>
          <span style={{ fontSize: 11, color: '#9CA3AF' }}>{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        </div>
        <Pills items={SPORTS} active={sf} onChange={setSf} color="#6EE7B7" />
        {tab !== 'props' && <Pills items={BET_TYPES} active={bf} onChange={setBf} color="#818CF8" />}
      </div>

      {/* Content */}
      <div style={{ padding: '8px 12px 90px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 60, color: '#9CA3AF' }}>Loading...</div>}
        {error && <div style={{ textAlign: 'center', padding: 40, color: '#DC2626', fontSize: 13 }}>Error: {error}<br /><span style={{ fontSize: 11, color: '#9CA3AF' }}>Check Vercel env vars</span></div>}
        {data && tab === 'picks' && <PicksTab picks={data.todayPicks} sf={sf} bf={bf} />}
        {data && tab === 'scores' && <ScoresTab liveGames={liveGames} picks={data.todayPicks} sf={sf} bf={bf} />}
        {data && tab === 'props' && <PropsTab props={data.props} sf={sf} />}
        {data && tab === 'results' && <ResultsTab results={data.gradedPicks} sf={sf} bf={bf} />}
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
          }}>
            <span style={{ fontSize: 17 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: 700, borderBottom: tab === t.id ? '2px solid #111827' : '2px solid transparent', paddingBottom: 1 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
