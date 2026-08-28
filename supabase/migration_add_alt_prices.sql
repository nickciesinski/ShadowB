-- ============================================================================
-- Migration: performance_log.alt_prices
-- Added 2026-08-28 for 3-way (Home/Draw/Away) side selection in the web app.
--
-- WHY: the soccer system logs ONE moneyline pick per match (the best-edge side
-- of home/draw/away). The web app lets you put yourself on a different side than
-- the model, but with only one side in the table it had no price for the other
-- two and fell back to a two-way "swap the team, flip the sign on the odds"
-- approximation -- which is wrong for a 3-outcome market and cannot express a
-- draw at all. This column carries all three de-vigged prices on the ONE row.
--
-- WHY ONE COLUMN AND NOT THREE ROWS: pick_id is league|date|game|market (one
-- pick per market, exactly-once). Writing home/draw/away as three rows would
-- break that dedupe and, worse, count all three as real picks against Units
-- Returned. This is display data attached to a single logged pick -- it must
-- never become three ledger entries.
--
-- Shape: {"home": -150, "draw": 240, "away": 310}  (American odds)
-- NULL for handicap/total rows, for US-sports rows, and for any match where the
-- feed didn't return a complete 3-way market. The app greys out unavailable
-- sides rather than showing a made-up number, so NULL is safe.
--
-- RUN THIS BEFORE deploying the ShadowB-Soccer code change. src/db.js upserts
-- the whole row object; if the column doesn't exist yet, the insert fails and
-- the nightly generate job writes NO picks at all.
-- ============================================================================

ALTER TABLE performance_log
  ADD COLUMN IF NOT EXISTS alt_prices JSONB;

-- Verification (expect one row back, data_type = jsonb):
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'performance_log' AND column_name = 'alt_prices';
--
-- After the next soccer generate run, expect populated JSON on moneyline rows:
--   SELECT date, game, market, pick, odds, alt_prices
--   FROM performance_log
--   WHERE league = 'EPL' AND market = 'moneyline' AND alt_prices IS NOT NULL
--   ORDER BY date DESC LIMIT 5;
