# Model versions (US sports)

Every pick in `performance_log` carries a `model_version`, so results can be
split by what produced them. Each version below also has a matching git tag.

**When to bump** (`MODEL_VERSION` in `src/predictions.js`):
- **Small bump** (v2.3 → v2.3.1): a fix. Picks before and after are still
  comparable and stay in the running MLB measurement (it matches `v2.3*`).
- **Big bump** (v2.3 → v2.4): a real model change. The measurement starts fresh,
  so only do this when old and new picks should not be pooled.

| Version | Live from | What changed | Leagues whose picks changed |
|---|---|---|---|
| (blank) | before 2026-07-31 | Label not yet recorded | — |
| v2.0-pre-feature-vocab | 2026-07-31 | First labelled version | all |
| v2.2-corrupt-offense | 2026-08-09 | One day of picks where season totals swamped the model. Do not pool. | MLB |
| v2.3-rate-gate-2026-08-09 | 2026-08-10 | Scoring-rate sanity gate | all |
| v2.3.1-2026-09-25 | 2026-09-25 | NFL picks keep their own matchup (no phantom games); NFL records and points allowed from ESPN standings; ESPN asked one day at a time | NFL |

## How to see results by version
In Supabase → SQL Editor:
```sql
select league, model_version, count(*) picks,
       round(avg(clv_prob_delta)*100, 2) as avg_clv_pp,
       round(sum(unit_return), 2) as units
from performance_log
where result is not null
group by 1, 2 order by 1, 2;
```
