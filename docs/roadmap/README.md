# Where everything is (start here)

Everything the weekly checks need now lives in this repo. Nothing to sync by hand.

| What | Where | Written by | When |
|---|---|---|---|
| Staked ROI / CLV scoreboard | `clean-era-reports/<date>.md` | GitHub job | Sun ~4:30 AM PT |
| Pick-bias drift check (Over/Home/favorite leans + weights) | `bias-drift-reports/<date>.md` | GitHub job | Sun ~5:05 AM PT |
| Feature → CLV attribution | `feature-clv-reports/<date>.md` | GitHub job | Sun ~4:45 AM PT |
| Threshold tuner review | `threshold-reviews/<date>.md` | GitHub job (dry-run since 2026-08-02, so no new files) | Sun |
| ROI roadmap + ticket status | `docs/roadmap/ROI-roadmap.md` | Weekly Claude run | Sun ~10:41 AM PT |
| Weekly progress log (newest on top) | `docs/roadmap/progress-log.md` | Weekly Claude run | Sun ~10:41 AM PT |
| Live model weights | `config/model-params.<LEAGUE>.json` | optimizer / by hand | — |

The one Sunday Claude task ("Shadow Bets weekly ROI-roadmap run") reads all of
the above, advances one safe ticket, pushes it, and writes the progress log.
It only pings Nick if something needs him.

The older Shadowbets folder (Briefs/, Optimization Plans/) on Nick's computer
is now history — this folder replaces the roadmap + progress log. The Google
Sheet "Weights_*" tabs are stale (anchor 0.78–0.81, sp_prob 2.1–3.0) and are
not what the model uses; `config/model-params.*.json` is.
