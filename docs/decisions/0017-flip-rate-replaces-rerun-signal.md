# 0017 — Score pass/fail flips; drop the workflow re-run signal

**Status**: Accepted. Refines the memory consequence of 0003.

## Context

The first flake score blended pass-after-retry (0.45), same-commit
intermittence (0.30), failure-mode diversity (0.15) and the workflow re-run
rate (0.10). Two gaps showed up:

- **No retries, a new commit every run.** Intermittence needs a pass and a fail
  on the same commit, and pass-after-retry needs retries. A JUnit repo without
  `rerunFailingTestsCount`, where every push is a new commit, fires neither: a
  test failing at random 25% of the time scored close to 0.
- **The re-run signal blamed bystanders.** It counted every event with
  `run_attempt > 1`, whatever that test's own result. After "re-run all jobs",
  every healthy test in the workflow gained up to 10 points. A re-run that
  rescues a test happens on the same commit, so intermittence already counts
  it.

## Decision

- `aggregate.ts` records, for each test, the passed-or-failed outcome of every
  `push` and `schedule` run, one sequence per `(branch, matrix cell)`. At the
  end each sequence is sorted by `started_at` (then `run_attempt`) and the
  pass↔fail transitions are counted: `flips` over `flipPairs` consecutive
  pairs. Skips are left out.
- Only `push` and `schedule` count because events do not store the repo's
  default branch; those triggers run code that is already merged, so a flip
  there points at the test, not the code. Pull-request runs, where the code
  really changes between commits, do not count.
- `flipRate = min(1, 3 × flips / flipPairs)`. Random failure at rate p flips
  2p(1−p) of the time (0.375 at 25%), so a raw rate never reaches 1 and a 25%
  random failure would sit right at the dashboard's flaky line of 20. Scaling
  by 3 saturates the signal from about 20% random failure and lets about 13%
  cross the line on flips alone. A test that broke once and was fixed flips
  twice and stays near 0.
- The re-run signal and `rerunRuns` are removed.
- Weights: pass-after-retry 0.35, flip rate 0.30, intermittence 0.20,
  failure-mode diversity 0.15.
- `test/score.test.ts` pins the intended behaviour with scenario fixtures:
  always fails, broke once then fixed, 25% random with no retries, a healthy
  test in a "re-run all jobs", and flakiness in one matrix cell only.

## Consequences

- Scores change between versions; the same data ranks differently after
  upgrading. `--json` loses `signals.rerunRate` and gains `signals.flipRate`.
- `report` memory is no longer bounded by distinct tests alone (0003): each
  push/schedule run adds a small `(time, attempt, failed)` entry until the
  aggregate is finalized. Intermittence buckets already grew with distinct
  commits, so the bound was already per-commit; streaming still means the
  history is never held as events.
- A push to a feature branch counts like one to the default branch. If that
  proves noisy, a flag naming the long-lived branches is the next step.
- A re-run that rescues a test on a push is counted by both intermittence and
  flip rate; that is a real flake, so the overlap is accepted.
