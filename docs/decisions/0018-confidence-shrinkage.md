# 0018 — Discount small samples by shrinkage, not a hard cutoff

**Status**: Accepted

## Context

Ranking used a hard `--min-runs` cutoff (default 5): a test with 4 passed or
failed runs was set aside, and one with 5 counted fully. Above the cutoff, a
test with 1 bad run out of 5 and one with 20 out of 100 got the same score,
although the second is far better evidence.

The score blends four signals rather than measuring one pass/fail proportion,
so a textbook interval does not strictly apply. A Wilson lower bound (95%) on
the blend was considered: it scores 20-of-100 at 13 and a test failing at
random 25% of the time over 40 runs at about 17, below the dashboard's flaky
line of 20. It discounts even well-sampled tests too hard.

## Decision

- `scoreTest` shrinks the blend toward 0:
  `confidence = eligibleRuns / (eligibleRuns + 5)` and
  `score = round(100 × raw × confidence)`. A test needs 5 runs to keep half its
  raw score; 40 runs keep 89%, 100 runs 95%.
- `score` is the discounted value; ranking and the dashboard thresholds use it.
  `FlakeScore` also carries `rawScore` and `confidence`, and `--json` prints
  them as `raw_score` and `confidence`.
- The prior strength is fixed at 5, not tied to `--min-runs`, so changing what
  is displayed never changes a score.
- `--min-runs` stays, default 5, as a display filter: tests below it are still
  scored and listed with `--all`.

## Consequences

- 1 bad run out of 5 (score 10) ranks below 20 out of 100 (score 19).
- Every score drops somewhat, most for young tests; a well-sampled flaky test
  barely moves.
- The table and dashboard show only the discounted score; the raw blend is in
  `--json`.
