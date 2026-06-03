-- ============================================================================
-- Migration: add missing columns to performance_log + prediction_features
-- Date: 2026-06-03
-- Reason: Supabase dual-write has been silently failing since 2026-04-23 with
--   "Could not find the 'approval_status' column" — the dual-write payload
--   evolved (4/23 added approval_status, 5/1-5/2 added predicted_prob,
--   market_prob, edge_driver, pick_purpose, prediction_correct) but the table
--   schema was never updated. Postgres aborted every insert on the first
--   missing column. Net effect: 41 days of frozen Supabase performance_log
--   and a completely starved nightly optimizer.
--
-- Run in: Supabase project → SQL Editor → paste this whole block → Run.
-- Safe to re-run (uses IF NOT EXISTS).
-- ============================================================================

-- performance_log: add the columns the dual-write has been trying to insert
ALTER TABLE performance_log
  ADD COLUMN IF NOT EXISTS approval_status TEXT,
  ADD COLUMN IF NOT EXISTS predicted_prob NUMERIC,
  ADD COLUMN IF NOT EXISTS market_prob NUMERIC,
  ADD COLUMN IF NOT EXISTS edge_driver TEXT,
  ADD COLUMN IF NOT EXISTS pick_purpose TEXT,
  ADD COLUMN IF NOT EXISTS prediction_correct BOOLEAN;

-- Helpful index for nightly optimizer queries (filters by date + approval_status)
CREATE INDEX IF NOT EXISTS idx_perf_date_approval
  ON performance_log(date DESC, approval_status);

-- Verification queries (run after, expected output shown in comments):
-- 1. Confirm columns exist:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'performance_log' AND column_name IN
--    ('approval_status','predicted_prob','market_prob','edge_driver',
--     'pick_purpose','prediction_correct');
--    → should return all 6 rows
--
-- 2. After trigger4 next runs, confirm fresh inserts:
--    SELECT date, league, market, approval_status, predicted_prob, pick_purpose
--    FROM performance_log ORDER BY date DESC LIMIT 5;
--    → should show today's date with non-null values in the new columns
