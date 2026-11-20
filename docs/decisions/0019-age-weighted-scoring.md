# 0019 — Weight runs by age, measured from the newest run

**Status**: Accepted

## Context

Every run in the window counted the same. A test that was flaky three months
ago and has passed 200 times since kept a share of its old score, and `--since`
could only cut history off at a hard edge.

## Decision

- Each run weighs `2^(−age / half-life)`. `report` and `dashboard` take
  `--half-life <Nd|Nh|off>`, default `14d`; `off` weights every run 1.
- Age is measured from the **newest run in the aggregated events**, not the
  clock. A repo last collected a month ago, or a `--since` window that ends in
  the past, scores as it did then; only runs that are old relative to the rest
  fade. A test that has not run since others did fades too.
- `TestAggregate` keeps its plain counts and adds `weighted`, the counts
  scoring reads: passed, failed and pass-after-retry runs weigh by their own
  start; a commit bucket by its latest passed or failed run; a flip pair by its
  later run; a failure fingerprint by the latest run it appeared in. A run
  whose start does not parse counts as infinitely old, so its weight never
  depends on read order. Without a half-life,
  `weighted` equals the counts.
- Confidence (0018), the `RUNS` column, `RETRY%`, `INTERMIT`, `eligible_runs`
  and `--min-runs` use the real counts. Weighting confidence too would cap it
  for tests that run rarely: with a 14-day half-life a daily test could never
  pass about 0.8 and a weekly one about 0.4, however long its history. Old
  flakiness still fades, through the rates.
- Streaming (0003) does not know the newest run until the end, so the running
  passed/failed/flaky weights are kept relative to the newest run seen so far
  and rescaled when a newer one arrives. Weights never exceed 1, so nothing
  overflows. Buckets, fingerprints and flip entries record their latest time
  and are weighted when the aggregate is finalized.

## Consequences

- Scores change again, and depend on the half-life. `--half-life off` gives
  the 0018 scores.
- A score is no longer read straight off the visible counts: `RETRY%` and
  `INTERMIT` show plain counts, while the score uses weighted ones.
- The library default (`Aggregator` without `halfLifeMs`) is unweighted; the
  14-day default lives in the commands.
