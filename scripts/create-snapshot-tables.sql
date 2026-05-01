-- Daily stat snapshots for historical accuracy
-- Run this in Supabase SQL Editor to create the snapshot tables

-- 1. Daily team stats snapshot
CREATE TABLE IF NOT EXISTS daily_team_stats (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  team TEXT NOT NULL,
  abbr TEXT NOT NULL,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  win_pct NUMERIC(5,3) DEFAULT 0,
  off_rating NUMERIC(6,1),
  def_rating NUMERIC(6,1),
  pace NUMERIC(6,1),
  points_for NUMERIC(6,1),
  points_against NUMERIC(6,1),
  recent_form_pct NUMERIC(5,3),
  last10_wins INT,
  last10_losses INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, league, abbr)
);

CREATE INDEX IF NOT EXISTS idx_daily_team_stats_date ON daily_team_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_team_stats_league ON daily_team_stats(league);

-- 2. Daily odds snapshot (consensus per game+market+outcome)
CREATE TABLE IF NOT EXISTS daily_odds (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  game TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  commence_time TEXT,
  market TEXT NOT NULL,
  outcome TEXT NOT NULL,
  consensus_price NUMERIC(8,2),
  consensus_line NUMERIC(6,2),
  book_count INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, league, game, market, outcome)
);

CREATE INDEX IF NOT EXISTS idx_daily_odds_date ON daily_odds(date);
CREATE INDEX IF NOT EXISTS idx_daily_odds_league ON daily_odds(league);

-- 3. Daily injury state snapshot
CREATE TABLE IF NOT EXISTS daily_injuries (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  league TEXT NOT NULL,
  team TEXT DEFAULT '',
  player TEXT NOT NULL,
  status TEXT NOT NULL,
  severity NUMERIC(3,2) DEFAULT 0,
  is_key_player BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, league, player)
);

CREATE INDEX IF NOT EXISTS idx_daily_injuries_date ON daily_injuries(date);
CREATE INDEX IF NOT EXISTS idx_daily_injuries_league ON daily_injuries(league);

-- Retention policy: keep 120 days of snapshots (auto-cleanup optional)
-- You can add a pg_cron job to DELETE FROM daily_team_stats WHERE date < NOW() - INTERVAL '120 days';
