-- Shadow Bets Supabase Migration
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- ============================================================================
-- TABLE: performance_log
-- Historical picks with grading (migrated from Google Sheets "Performance Log" tab)
-- ============================================================================
CREATE TABLE performance_log (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  game TEXT,
  market TEXT NOT NULL, -- 'spread', 'moneyline', 'total'
  pick TEXT,
  line NUMERIC,
  odds INTEGER,
  implied_prob NUMERIC,
  confidence INTEGER,
  base_units NUMERIC,
  modifier NUMERIC DEFAULT 1.0,
  final_units NUMERIC,
  result TEXT, -- 'W', 'L', 'P', NULL (pending)
  unit_return NUMERIC,
  clv_opening_prob NUMERIC,
  clv_closing_prob NUMERIC,
  clv_grade TEXT, -- 'GOOD', 'FLAT', 'BAD'
  trigger_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_perf_date_league ON performance_log(date, league);
CREATE INDEX idx_perf_league_market ON performance_log(league, market);
CREATE INDEX idx_perf_result ON performance_log(result);

-- ============================================================================
-- TABLE: performance_modifiers
-- Auto-updated league+market multipliers
-- ============================================================================
CREATE TABLE performance_modifiers (
  id SERIAL PRIMARY KEY,
  league TEXT NOT NULL,
  market TEXT NOT NULL,
  modifier NUMERIC NOT NULL DEFAULT 1.0,
  sample_size INTEGER DEFAULT 0,
  win_rate NUMERIC,
  roi NUMERIC,
  last_period_start DATE,
  last_period_end DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league, market)
);

-- ============================================================================
-- TABLE: prop_performance
-- Prop edge grades (CLV-based)
-- ============================================================================
CREATE TABLE prop_performance (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  player TEXT NOT NULL,
  market TEXT NOT NULL,
  line NUMERIC,
  direction TEXT, -- 'Over', 'Under'
  book TEXT,
  opening_edge NUMERIC,
  closing_edge NUMERIC,
  edge_movement NUMERIC, -- closing - opening
  clv_grade TEXT, -- 'HIT', 'MISS'
  weight_modifier NUMERIC,
  status_bump NUMERIC DEFAULT 0,
  adjusted_edge NUMERIC,
  confidence INTEGER,
  units NUMERIC,
  actual_result TEXT, -- 'W', 'L', NULL (pending)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_prop_perf_date ON prop_performance(date, league);
CREATE INDEX idx_prop_perf_market ON prop_performance(league, market);

-- ============================================================================
-- TABLE: prop_weights
-- Market-level weights per league (CLV-based)
-- ============================================================================
CREATE TABLE prop_weights (
  id SERIAL PRIMARY KEY,
  league TEXT NOT NULL,
  market TEXT NOT NULL,
  weight NUMERIC NOT NULL DEFAULT 1.0,
  sample_size INTEGER DEFAULT 0,
  clv_hit_rate NUMERIC,
  avg_edge NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league, market)
);

-- ============================================================================
-- TABLE: clv_snapshots
-- Opening/closing odds for CLV tracking
-- ============================================================================
CREATE TABLE clv_snapshots (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  game TEXT NOT NULL,
  market TEXT NOT NULL,
  snapshot_type TEXT NOT NULL, -- 'opening', 'midday', 'closing'
  home_team TEXT,
  away_team TEXT,
  home_odds INTEGER,
  away_odds INTEGER,
  line NUMERIC,
  total NUMERIC,
  implied_prob_home NUMERIC,
  implied_prob_away NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_clv_date_type ON clv_snapshots(date, snapshot_type);
CREATE INDEX idx_clv_league ON clv_snapshots(league, game);

-- ============================================================================
-- TABLE: prop_status
-- Player status snapshots (scratch/injury detection)
-- ============================================================================
CREATE TABLE prop_status (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  player TEXT NOT NULL,
  game TEXT,
  status TEXT NOT NULL, -- 'active', 'scratched', 'questionable', 'out'
  previous_status TEXT,
  impact_type TEXT, -- 'high_usage', 'target_redist', 'pitcher_scratch', 'goalie_scratch'
  edge_bump NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_status_date ON prop_status(date, league);

-- ============================================================================
-- TABLE: trigger_log
-- Trigger execution history
-- ============================================================================
CREATE TABLE trigger_log (
  id BIGSERIAL PRIMARY KEY,
  trigger_name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'SUCCESS', 'FAILED', 'RUNNING'
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration_sec NUMERIC,
  records_processed INTEGER,
  error_message TEXT,
  memory_mb NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trigger_name ON trigger_log(trigger_name, start_time);

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Last 30 days performance by league+market
CREATE VIEW v_modifier_inputs AS
SELECT
  league,
  market,
  COUNT(*) as sample_size,
  COUNT(*) FILTER (WHERE result = 'W') as wins,
  COUNT(*) FILTER (WHERE result = 'L') as losses,
  ROUND(COUNT(*) FILTER (WHERE result = 'W')::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE result IN ('W','L')), 0) * 100, 1) as win_rate,
  ROUND(SUM(COALESCE(unit_return, 0))::NUMERIC / NULLIF(SUM(ABS(final_units)), 0) * 100, 1) as roi,
  SUM(COALESCE(unit_return, 0)) as net_units
FROM performance_log
WHERE date >= CURRENT_DATE - INTERVAL '30 days'
  AND result IN ('W', 'L')
GROUP BY league, market
ORDER BY roi DESC;

-- Prop weight inputs (last 7 days CLV data)
CREATE VIEW v_prop_weight_inputs AS
SELECT
  league,
  market,
  COUNT(*) as sample_size,
  COUNT(*) FILTER (WHERE clv_grade = 'HIT') as hits,
  ROUND(COUNT(*) FILTER (WHERE clv_grade = 'HIT')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) as hit_rate,
  ROUND(AVG(ABS(edge_movement)), 2) as avg_edge_movement
FROM prop_performance
WHERE date >= CURRENT_DATE - INTERVAL '7 days'
  AND clv_grade IS NOT NULL
GROUP BY league, market
ORDER BY hit_rate DESC;

-- Confidence calibration view
CREATE VIEW v_confidence_calibration AS
SELECT
  CASE
    WHEN confidence <= 2 THEN '1-2 (low)'
    WHEN confidence <= 4 THEN '3-4 (below avg)'
    WHEN confidence <= 6 THEN '5-6 (mid)'
    WHEN confidence <= 8 THEN '7-8 (high)'
    ELSE '9-10 (elite)'
  END as bucket,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE result = 'W') as wins,
  ROUND(COUNT(*) FILTER (WHERE result = 'W')::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE result IN ('W','L')), 0) * 100, 1) as win_rate,
  ROUND(SUM(COALESCE(unit_return, 0))::NUMERIC / NULLIF(SUM(ABS(final_units)), 0) * 100, 1) as roi
FROM performance_log
WHERE result IN ('W', 'L')
GROUP BY bucket
ORDER BY bucket;

-- ============================================================================
-- ROW LEVEL SECURITY
-- Service role bypasses RLS automatically, so no policies needed for our use case
-- ============================================================================
ALTER TABLE performance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE clv_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_log ENABLE ROW LEVEL SECURITY;
