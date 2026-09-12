# CLAUDE.md — ShadowB (US sports Shadow Bets)

This repo is the **US-sports** Shadow Bets prediction system (NFL / NBA / MLB /
NHL). The soccer/EPL system is a **separate** repo: `ShadowB-Soccer`. The two
systems share only a results ledger — don't cross wires between them.

## Start every session here
The source-of-truth docs live in Nick's `Shadowbets` project folder under
`Briefs/` (kept outside this repo). If you can reach that folder, read
`Briefs/new-thread-kickoff.md` FIRST — it routes you to the right system's
docs. Treat the briefs as the source of truth and keep them current as you
make changes.

## How Nick works (read this)
- Nick is not a strong coder. Explain changes plainly and conservatively — no
  over-engineering.
- Ask for his GitHub PAT at the start of any coding session.
- Push directly to `main` — no PRs.
- Every game must produce ML + spread + total picks. Low confidence = a tiny
  stake, never a dropped pick.

## Nick's betting windows — READ THIS BEFORE CHANGING ANY SCHEDULE OR FEATURE

Nick places bets by hand in one of two windows, both Pacific:

- **~9:00–9:30 PM PT** the night before, or
- **~5:30–6:00 AM PT** the morning of.

A pick that only exists outside those windows cannot be bet. Day-ahead picks are
fine but never required — lead time is not the goal.

**THE HARD RULE: a pick must never contradict itself.** Saying Team A on Monday
and Team B for the same game on Tuesday is a failure regardless of which was
right. Nick would rather have one stable pick than a sharper one that flips.

This is enforced in the DB, not by convention: `insertPerformanceRows()` upserts
with `onConflict: 'pick_id', ignoreDuplicates: true` — DO NOTHING, never DO
UPDATE. Once a side is locked for a game+market, later runs top up new games and
leave existing ones alone. **Do not change that to DO UPDATE**, and do not add a
re-pick path that rewrites a published side.

**Consequences for new features:** every feature must be collectable and
verifiable BEFORE the 9 PM PT window. A signal that only lands at noon on game
day is useless here, however predictive. A signal only published AFTER the game
is a leak — MLB umpire assignment was proposed and dropped for exactly that
(StatsAPI publishes officials only post-game; verified 2026-09-10, 0/15 before
vs 15/15 after). Declare new features at weight 0 so they are measured before
they are trusted; see `src/bullpen-fatigue.js` for the pattern.

## Data & environment notes
- Live pick data is in Supabase (project "ShadowPicks").
- Model weights/params live in `config/model-params.*.json` (owned by the
  optimizer), not in Google Sheets.
- The cloud sandbox has no Supabase/Sheets creds and blocks direct ESPN/curl
  calls — verify live data via GitHub Actions logs or ask Nick.

## Keeping the two systems in sync
ShadowB (US sports) and ShadowB-Soccer (EPL) are independent, but some changes
are meant for BOTH. When a change is **fundamental/shared** (not tied to one
sport's model), STOP and tell Nick it likely belongs in the sibling system too,
and offer to make the matching change. Then log it in
`Briefs/cross-system-sync-log.md`.

- Shared/fundamental (port to both): stake sizing, CLV logic, results-ledger
  format, pick-coverage rules (ML + spread + total must all appear),
  odds/price validation, calibration approach, email/digest plumbing.
- Sport-specific (do NOT copy across): the actual model guts — soccer's 3-way
  home/draw/away probabilities, NHL goalies, NBA pace/defRating, MLB pitchers,
  spreads/totals math.
