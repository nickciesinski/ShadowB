# ROI-Positive Roadmap (2026 H2) — status

GOAL: go-forward **staked** ROI > 0, sustained, on clean-era data (picks dated >= 2026-06-03).
Levers in order: selection (only stake when we beat the close) → price (best of 15+ books / plus money) → sizing (fractional Kelly on calibrated edge).
CLV is the leading indicator: +ROI on flat/negative CLV is variance and must NOT be chased.

Moved into the repo on 2026-11-16 (the original lived in the Shadowbets folder, which
cloud runs could not reach). Statuses below are rebuilt from the git history.

| Ticket | What | Status |
|---|---|---|
| R0 | Quarantine weight auto-apply; honest clean-era ROI report; Dashboard from Supabase (R0.3) | DONE |
| R1.1 | CLV in the clean-era report | DONE |
| R1.2 | CLV-aware threshold tuner (don't loosen +ROI/−CLV) | DONE |
| R1.3 | CLV-beat staking gate (`config/clv-gate.json`) | DONE — inert (enabled:false). Listed NHL segment no longer qualifies (2026-11-16) |
| R2.1 | Log + grade at best available price (line shopping) | DONE |
| R2.2 | Plus-money / anti-chalk analysis | TODO — report-only first. Price-class table already in clean-era report |
| R3.3 | Calibration (probability scale) | IN PROGRESS — measure/report-only shipped (`src/prob-calibration.js`) |
| R4.1 | Fractional Kelly sizing | TODO — simulation/report-only first, no live stake change |
| R5.1 | Out-of-sample apply gates | DONE — (a) guardrail tests, (b) weight optimizer cf-gate (inert), (c) threshold tuner OOS gate (inert, 2026-11-16, `1075f1f`) |
| R5.2 | JSON param store; rebase-before-push | DONE |
| Rule C | Pre-registered plus-money + disagreement rule | Scored weekly; level REJECTED out-of-sample. Do not stake |
| Bias watch | Weekly bias-drift report (`bias-drift-reports/`) | DONE 2026-11-16 |
| NBA spread margins | Projected margin has no pull toward the market line → NBA spreads ~100% favorites | OPEN — watch; if Fav% stays > 75% with n ≥ 15, design a market-anchor step (weight 0 / measured first) |

## Status notes
- 2026-11-16: R5.1(c) shipped inert. Fixed NBA totals tracking-only never matching (over/under label), `b894bed`. Docs moved into repo.
