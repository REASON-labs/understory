# Recall benchmark

Baseline harness for Phase 1. Measures `recall@k` of the current retrieval path
(`kb.search()` → the keyword scan in `okf/search.ts`) against a gold set of
query→expected-path pairs, split into `exact` queries (the keyword scorer should
nail these) and `paraphrase` queries (the target concept's literal terms are
absent — structurally hard for keyword search, and where embedding retrieval
should win).

```
pnpm build           # @understory/core must be built; the harness imports it
pnpm bench:recall            # human-readable table
pnpm bench:recall -- --json  # machine-readable, for CI diffing
```

Point it at any bundle / gold set:

```
BENCH_BUNDLE=/path/to/bundle BENCH_GOLD=/path/to/gold.json pnpm bench:recall
```

`recall@k (any)` = at least one expected concept in the top-k results (the
LongMemEval / iai-pme `recall_any@k` convention).

## The gate

This is the number PR-1d (hybrid retrieval) must beat. The bar: lift the
**paraphrase** split materially while holding **exact** at 100% and not
regressing precision. Record the before/after in the PR.

## Baseline (keyword scan)

Reference numbers on the fixture bundle, for regression tracking:

| split      | r@1   | r@5   | r@10  |
|------------|-------|-------|-------|
| exact      | 100%  | 100%  | 100%  |
| paraphrase | 16.7% | 50.0% | 66.7% |
| overall    | 58.3% | 75.0% | 83.3% |

Some paraphrase queries still hit via incidental token overlap — that's honest
keyword noise, left in rather than engineered to zero. The per-query ranks in
the output show which.

## Extending the gold set

`gold.json` is meant to grow. Add real query→concept pairs from your own bundle
(via `BENCH_GOLD`), especially paraphrase cases you've seen keyword search miss
in practice — those are the cases that justify the embedding work.
