# Novig maker-fill reports

Weekly readout of the pre-registered venue test fixed on 2026-09-12 in
`config/novig-fill-test.json`.

**The question.** Every model lever measured so far moves CLV by 0.1–0.3pp
against a book vig of ~1.7pp. Posting a maker order 10 cents better than the
best book is worth ~2.2pp of price — the first mechanism in this project of the
right order of magnitude to clear that wall. The 2026-08-31 venue analysis
concluded the remaining gap was venue, not model, and could not test it. This
tests it.

**The bar, fixed in advance.** Fill-conditional net edge (`clv_prob_delta` −
Novig maker fee) > 0 at |t| ≥ 2, clustered by `game_key`, minimum 40 fills,
measured from 2026-09-12.

**How to read a report**

- The **verdict** follows the *logged* price, not the fill price. The
  improvement is reported separately and marked optimistic, because
  `clv_prob_delta` is already measured against the ledger's price and adding
  the improvement on top risks counting it twice.
- **Open orders are not misses.** An order still at `ordered` has not resolved
  and is excluded from the fill rate; including it would make the number depend
  on what time the report ran.
- **The 2026-09-11 pilot is never pooled in.** Eight orders on one day, on a day
  that ran roughly double rule C's historical CLV. It appears in its own
  section, labelled not-evidence.
- **CLV capture ratio** is filled mean CLV ÷ missed mean CLV. Near 1 means the
  venue is not picking us off; well under 1 means the misses were the windfalls.
  It is computable only because the misses are recorded — a fill-only log
  answers a flattering version of the question.
- `INSUFFICIENT` is the honest state below 40 fills and cannot be overridden by
  a good-looking mean.

**Pieces**

| File | Job |
|---|---|
| `config/novig-fill-test.json` | the pre-registration — decision rule and kill conditions |
| `web/app/api/novig/route.js` | the order log (posted / filled / no fill) |
| `src/novig-settle.js` | closes out orders never marked, pessimistically |
| `src/novig-eval.js` | pure scorer — arithmetic only, imports nothing live |
| `scripts/novig-fill-report.js` | reads Supabase, writes the report here |

Nothing in this chain selects, sizes or places a bet. Turning a confirmed
result into a staking rule is a separate, deliberate commit.
