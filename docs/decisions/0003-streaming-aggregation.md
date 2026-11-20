# 0003 — Aggregate in-process by streaming

**Status**: Accepted. 0017 refines the memory bound below.

## Context

`report` and `dashboard` need per-test flake signals over the whole stored
history. At personal and small-team scale that history is thousands to a few
million lines — too much to load into memory comfortably, far too little to
justify a database or a native query engine.

## Decision

Reports read a repo's partitions one line at a time, oldest month first
(`src/report/read.ts`), and fold each event into an incremental `Aggregator`
(`aggregate.ts`) keyed by test `id` (or `(id, matrix)` with `--by-matrix`). The
history is never materialized. The aggregate holds raw signals only; scoring and
ranking are separate steps (`score.ts`, `rank.ts`). Per-test timelines, which
only the dashboard needs, are opt-in.

## Consequences

- Reports start instantly with zero native dependencies and memory bounded by
  the number of distinct tests, not events.
- Every report re-reads all partitions in range; there is no cache or index.
- When that stops being fast enough, the growth path is 0004, over the same
  files.
