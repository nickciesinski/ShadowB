# Roadmap Progress Log (newest on top)

## 2026-11-16 — weekly ROI-roadmap run

**Scoreboard (clean-era-reports/2026-11-15.md, approved/staked, clean era since 6/3)**
Headline staked ROI **-2.4%** on 958u (all markets, all leagues).

| Seg | Staked ROI | CLV beat / avg | Call |
|---|---|---|---|
| MLB ML | -5.5% (n=787) | 54.1% / +0.32pp | -ROI, +CLV: price problem (net edge < 0). Hold |
| MLB spread | -4.0% (n=770) | 55.3% / +0.43pp | -ROI, +CLV. Hold |
| MLB total | +7.1% (n=593) | 48.4% / +0.32pp | +ROI, flat CLV. Hold, don't loosen |
| NBA spread | +7.7% (n=176) | 36.9% / +0.06pp | +ROI, flat/-CLV. Hold, don't loosen (7d -23.9%) |
| NBA total | -11.0% (n=153) | 17.8% / -0.04pp | Fade. Was meant to be tracking-only since 10/31; a bug let it keep staking. **Fixed today** |
| NHL ML | -11.1% (n=253) | 51.8% / +0.24pp | -ROI, mild +CLV. Hold |
| NHL spread | -8.2% (n=255) | 53.7% / +0.15pp | -ROI, mild +CLV. Hold |
| NHL total | -0.9% (n=194) | 57.1% / +0.56pp | Best CLV on the board. Watch: lean-in candidate if ROI follows |
| NFL ML | +1.6% (n=66) | 39.4% / -1.21pp | +ROI on -CLV = variance. Hold, don't loosen |
| NFL spread | -2.8% (n=65) | 41.3% / -0.21pp | Fade/tighten |
| NFL total | -11.6% (n=55) | 36.4% / +0.06pp | Fade/tighten |

- **Net edge by price class:** negative in every league/price class. Plus money is consistently the least-bad (MLB -0.43pp, NHL -0.70pp) vs minus money (-1.75 to -2.64pp). No segment clears the vig yet.
- **Rule C:** separates (+1.32pp, t 11.3) but level REJECTED (-0.61pp/game). Do not stake.
- **CLV gate (config/clv-gate.json):** stays enabled:false. No segment meets the criteria (avg <= -1.5pp AND beat <= 45%, n>=20). Closest: NFL ML (-1.21pp / 39.4%). Note: the one listed gated segment (NHL *) no longer qualifies — NHL is now +0.29pp / 54% — so remove it before ever flipping the gate on.
- **Threshold tuner:** last written review is 2026-08-02 — by design (scheduled runs are dry-run since 8/2), not a broken job.

**Staged folders:** all 5 `Roadmap Step ... (to commit)` folders (R5.1, Autopilot-6, Venue-Fill-Eval, Rule-C-Eval, Test-Fix) are already on main → redundant, safe to delete.

**Ticket advanced:** R5.1(c) — DONE (inert). Out-of-sample apply gate on the threshold tuner: a loosening needs days 8-30 to show staked ROI > 0, CLV >= 0 and net edge >= 0 (n>=50). Tightening is never blocked. `config/threshold-oos-gate.json` enabled:false.
**Bug fix:** NBA totals tracking-only never matched (total picks are labelled over/under). Live effect: NBA totals now tracking-only as intended (still logged, same side).

**Tests:** 598/598 green (was 582; +16).
**Pushed to main:** `1075f1f` (R5.1c), `b894bed` (NBA totals fix).

**Nick's one next step:** check tomorrow's NBA card shows totals as tracking-only (no stake). Then delete the 5 redundant staged folders.
**Next ticket:** R2.2 plus-money / anti-chalk analysis (report-only) — the price-class table says plus money is where the net edge is least negative.

**Later the same day:** added the weekly bias-drift GitHub job (`bias-drift-reports/`, Sun 5:05 AM PT, read-only) and moved the roadmap + this log into `docs/roadmap/`. First drift check (2026-11-09 → 11-15, one day of picks): DRIFT on NBA spreads (9/9 favorites) and NBA totals (2/9 Over), small samples; weights intact (anchor 0.95, sp_prob ≤ 0.1).
