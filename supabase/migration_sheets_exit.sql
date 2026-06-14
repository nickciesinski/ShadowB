-- ============================================================================
-- Google Sheets exit — staging snapshot store
-- ============================================================================
-- Category B "external data" tabs (Today_Odds, Schedule_Context, Injury Summary,
-- team stats, player props/tiers) are ephemeral "latest slate" data, not
-- historical analytics. Rather than a fragile per-tab schema + mapper, we store
-- each refresh as a full row-array snapshot keyed by entity. Round-trips are
-- byte-identical to the Sheet, so dual-mode shows guaranteed parity and the
-- eventual supabase-only flip is safe.
--
-- Apply with: psql "$SUPABASE_DB_URL" -f supabase/migration_sheets_exit.sql
-- (or paste into the Supabase SQL editor). Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sheet_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,            -- 'gameOdds' | 'scheduleContext' | 'injuries' | ...
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rows        JSONB NOT NULL            -- full [[...],[...]] row array, incl. header row
);

-- Fast "latest snapshot for entity" lookups.
CREATE INDEX IF NOT EXISTS idx_sheet_snapshots_entity_time
  ON sheet_snapshots (entity, captured_at DESC);

-- Optional retention helper: keep only the most recent N per entity.
-- (Run manually or from a nightly trigger; not required for correctness.)
-- DELETE FROM sheet_snapshots s USING (
--   SELECT id, row_number() OVER (PARTITION BY entity ORDER BY captured_at DESC) rn
--   FROM sheet_snapshots
-- ) r WHERE s.id = r.id AND r.rn > 5;

ALTER TABLE sheet_snapshots ENABLE ROW LEVEL SECURITY;
