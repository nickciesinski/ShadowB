# ROI-Positive Roadmap (2026 H2) — status

GOAL: go-forward **staked** ROI > 0, sustained, on clean-era data (picks dated >= 2026-06-03).
Levers in order: selection (only stake when we beat the close) → price (best of 15+ books / plus money) → sizing (fractional Kelly on calibrated edge).
CLV is the leading indicator: +ROI on flat/negative CLV is variance and must NOT be chased.

Moved into the repo on 2026-11-16 (the original lived in the Shadowbets folder, which
cloud runs could not reach). Statuses below are rebuilt from the git history.

## Where we are (2026-11-16 step-back)

The model beats the close by ~0.3pp per bet; books charge ~1.2–2.2pp. Net edge is
negative in every league and price class. Selection, thresholds and Kelly sizing move
CLV by 0.1–0.3pp — they cannot close a ~1.5pp gap. **Price (venue) is the binding
constraint.** The Novig maker test (`config/novig-fill-test.json`) is the only
mechanism of the right size (~2.2pp), and it has been PAUSED since 2026-09-13
because marking orders daily was too much work for Nick.

**Priority #1 — V1: make the venue test low-effort enough to actually run.**
Ideas to evaluate (propose to Nick, don't ship blind): fewer orders (only the top few
rule-C picks per day, flat stake); one tap per day instead of per order; settle and mark
fills automatically if Novig exposes order history; fold into the 9 PM digest.

**Rule for weekly runs:** no new inert flags until the existing three
(`cf-gate`, `clv-gate`, `threshold-oos-gate`) are turned on or deleted. Code only
when it serves V1 or measures something that decides money.

| Ticket | What | Status |
|---|---|---|
| **V1** | **Venue test (Novig maker orders) — make it low-effort, resume it** | **TOP PRIORITY — paused since 2026-09-13 (effort)** |
| R0 | Quarantine weight auto-apply; honest clean-era ROI report; Dashboard from Supabase (R0.3) | DONE |
| R1.1 | CLV in the clean-era report | DONE |
| R1.2 | CLV-aware threshold tuner (don't loosen +ROI/−CLV) | DONE |
| R1.3 | CLV-beat staking gate (`config/clv-gate.json`) | DONE — inert (enabled:false). Listed NHL segment no longer qualifies (2026-11-16) |
| R2.1 | Log + grade at best available price (line shopping) | DONE |
| R2.2 | Plus-money / anti-chalk analysis | TODO — report-only first. Price-class table already in clean-era report |
| R3.3 | Calibration (probability scale) | IN PROGRESS — measure/report-only shipped (`src/prob-calibration.js`) |
| R4.1 | Fractional Kelly sizing | PARKED — Kelly on negative net edge = stake 0; revisit once any segment shows net edge > 0 |
| R5.1 | Out-of-sample apply gates | DONE — (a) guardrail tests, (b) weight optimizer cf-gate (inert), (c) threshold tuner OOS gate (inert, 2026-11-16, `1075f1f`) |
| R5.2 | JSON param store; rebase-before-push | DONE |
| Rule C | Pre-registered plus-money + disagreement rule | Scored weekly; level REJECTED out-of-sample. Do not stake |
| Bias watch | Weekly bias-drift report (`bias-drift-reports/`) | DONE 2026-11-16 |
| NBA spread margins | Projected margin has no pull toward the market line → NBA spreads ~100% favorites | OPEN — watch; if Fav% stays > 75% with n ≥ 15, design a market-anchor step (weight 0 / measured first) |

## Status notes
- 2026-11-16 (later): step-back review. Price is the binding constraint; V1 made top priority; R4.1 parked; no new inert flags.
- 2026-11-16: R5.1(c) shipped inert. Fixed NBA totals tracking-only never matching (over/under label), `b894bed`. Docs moved into repo.
