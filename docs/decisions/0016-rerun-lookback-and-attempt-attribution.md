# 0016 — Catch re-runs with a 48-hour lookback and per-artifact attempts

**Status**: Accepted

## Context

Re-runs are the strongest flake signal, but GitHub makes them easy to miss or
miscount:

- A re-run keeps its run's `created_at`, and run listing filters by creation
  time, so the window past the watermark never shows a new attempt of an older
  run.
- A partial re-run ("re-run failed jobs") carries the untouched jobs' artifacts
  over, so one run's artifact list mixes attempts. Stamping them all with the
  run's latest attempt puts carried-over results under a second dedup key
  (0012) and double-counts them.

## Decision

- Listing reaches `--rerun-lookback-hours` (default 48, `0` disables) behind the
  window start once a repo has a watermark (`src/collect/rerun.ts`). A run from
  that stretch is collected only when its `run_attempt` beats the highest
  attempt already collected (`rerun_attempts` in state); filtered-out re-runs
  are recorded too. A repo collected before `rerun_attempts` existed seeds it
  from its first listing (`initialCollectedAttempts`).
- Each artifact is attributed to the latest attempt that had started when it
  was created (`attemptForArtifact`, one attempts lookup per extra attempt, only
  for re-run runs), and its events carry that attempt. Artifacts from attempts
  already collected are skipped before download.

The default was lowered from 168 hours to 48: re-runs of flaky tests land
within hours or days, and every collect re-lists the whole lookback stretch, so
a week of it multiplied listing API calls for little gain.

## Consequences

- Re-runs within two days of a run's creation are collected without a backfill,
  and carried-over results are never double-counted.
- An older re-run is collected only by a `--hours-back` backfill covering its
  creation date, or a larger `--rerun-lookback-hours`.
- State grows by one `rerun_attempts` entry per listed run above attempt 1.
