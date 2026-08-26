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

## Data & environment notes
- Live pick data is in Supabase (project "ShadowPicks").
- Model weights/params live in `config/model-params.*.json` (owned by the
  optimizer), not in Google Sheets.
- The cloud sandbox has no Supabase/Sheets creds and blocks direct ESPN/curl
  calls — verify live data via GitHub Actions logs or ask Nick.
