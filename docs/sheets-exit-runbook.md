# Google Sheets Exit — Activation Runbook

What's already shipped (commits on `main`):
- **Config**: model weights/params live in `config/model-params.*.json`; nothing reads weights from the Sheet. Mirror cut.
- **Phase 0**: `src/data-store.js` seam + `DATA_SOURCE` / per-entity modes in `config.js`.
- **Phase 1**: all Performance Log reads go through `dataStore.read('performanceRows')` (dual/shadow).
- **Phase 2**: `sheet_snapshots` store + dual-write for `gameOdds`/`scheduleContext`/`injuries` (gated; reads repointed).
- **Phase 3**: web app Supabase-first for today's picks/games + `/api/params` review endpoint.

Everything past config is **inert by default** — `DATA_SOURCE` modes keep the Sheet authoritative until you deliberately flip an entity. This runbook is the gated path to fully off.

## Modes
Per-entity mode resolves in `config.dataModeFor(entity)`:
- `sheet` — read the Sheet only (original behaviour).
- `dual` — read both, log row-count divergence, **return the Sheet value** (safe shadow).
- `supabase` — read Supabase, fall back to Sheet if empty.

Global override: env `DATA_SOURCE=sheet|supabase|dual` forces all entities. Per-entity defaults are all `sheet` (inert) in `DATA_SOURCE_MODES` (config.js); flip to begin.

## Step 1 — Apply the Supabase migration (required before any Category-B flip)
```
psql "$SUPABASE_DB_URL" -f supabase/migration_sheets_exit.sql
```
Creates `sheet_snapshots`. Idempotent.

## Step 2 — Turn on dual-write + shadow for one entity
Set the entity to `dual` (in `DATA_SOURCE_MODES`, or `DATA_SOURCE=dual` globally for a run). Then:
- `data-collection.js` starts writing that entity's snapshot to Supabase after each Sheet write.
- Readers shadow-read Supabase and log `[data-store] parity <entity>: N rows` or `DIVERGENCE`.

Watch logs (trigger3/10/11 for odds, the data-collection triggers for schedule/injuries; trigger14 for Performance Log) for a few cycles.

## Step 3 — Confirm parity, then flip to `supabase`
For Category B (snapshots) parity is byte-identical by construction; mainly confirm the dual-write is landing rows. For `performanceRows`, confirm divergence logs are clean (note the known `game` vs away/home mapping — verify split picks read correctly).

**For prediction-affecting entities, gate on picks-diff = 0**: run a slate in `dual`, capture generated picks, flip to `supabase`, run again, diff. Only flip when identical.

Flip by setting the entity's mode to `supabase`.

## Step 4 — Drop the now-dead Sheet writes
Once an entity is `supabase` and stable for ~1 week, remove its `setValues(...)` Sheet write in `data-collection.js` (keep one release as backstop first).

## Remaining work to be fully off
- **Phase 1b**: add `supa()` mappers for the other Category-A entities already registered in `data-store.js` (`propPerformanceRows`, `propStatusRows`, `modifierRows`, `clvSnapshotRows`, `triggerRuns`) → wire to existing `db.js` tables/views.
- **Phase 2b**: extend snapshots to `teamStats`, `playerProps`, `playerTiers/stats`, `yesterdayResults` (register + dual-write + repoint, same pattern as gameOdds).
- **Web**: move `props` (Prop_Combos) off the Sheet (snapshot or `prop_*` tables).

## Phase 4 — Decommission (DO NOT run until everything above is `supabase` and verified)
Irreversible. Checklist:
1. Confirm every entity in `DATA_SOURCE_MODES` is `supabase` and has been stable ≥1 week with zero divergence / picks-diff = 0.
2. Remove all remaining `setValues(...)`/`getValues(...)` Sheet calls (`grep -rn "getValues(SPREADSHEET_ID\|setValues(SPREADSHEET_ID" src scripts`).
3. Delete `src/sheets.js`; remove `googleapis` from `package.json` (root) — keep it in `web/` only if the web route still has a Sheet fallback.
4. Remove `GOOGLE_SERVICE_ACCOUNT_JSON` + `SPREADSHEET_ID` from all workflow `env:` blocks and from GitHub Secrets.
5. Remove the `SHEETS` map + `SPREADSHEET_ID` from `config.js`.
6. Set the Google Sheet itself to read-only (archive) — don't delete it for a few weeks.
7. Run `npm test` (diagnostics) + a full trigger cycle in staging to confirm no Sheet dependency remains.

Rollback at any point before Phase 4: set `DATA_SOURCE=sheet` (or revert the entity's mode) — the Sheet path is intact until Step 4 of each entity.
