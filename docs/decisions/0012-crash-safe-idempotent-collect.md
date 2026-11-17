# 0012 — Crash-safe, idempotent collection

**Status**: Accepted

## Context

`collect` runs unattended — from cron, CI, or by hand after an interruption.
Re-running it must always be safe, a crash must never silently skip data, and
two processes must never interleave writes to the same store.

## Decision

- **Dedup key** `(run_id, run_attempt, id, matrix)`; matrix cells serialize as
  JSON inside the key (`stableMatrix`) so cell content can never collide. A
  second `collect` over the same runs writes nothing.
- **Append first, then advance**: events are appended and fsynced (file and
  directory); only then does the watermark advance and `state.json` save
  (fsynced temp + rename). A crash in between is recovered by re-collecting.
- **Never pass a pending run**: the watermark stops at an in-progress run, and
  such runs are tracked in `pending_runs` and re-fetched by id until complete.
  The watermark may pass runs a filter excluded, so filtering never stalls.
- **Attempt attribution**: `run_attempt` is the attempt that uploaded each
  event's artifact, not the run's latest (0016).
- **Locks**: `<state-file>.lock` rejects a concurrent `collect` on the same
  state; `<data-dir>/.lock`, taken by `collect`, `compact` and `prune`, keeps
  compaction or pruning from deleting a partition mid-append. A stale lock (dead
  pid, or empty after a crash) is broken by an atomic rename-aside-then-verify;
  release deletes only a lock whose token is still ours; SIGINT/SIGTERM release
  it.

## Consequences

- Re-runs are always safe and nothing is silently skipped.
- Data collected before attempt attribution stamped carried-over results with
  the latest attempt; explicitly backfilling such a run stores them again under
  the corrected attempt. Upgrades avoid this on their own, since the re-run
  lookback seeds already-collected re-runs as collected.
- Each collect pays for a dedup-key read of the touched partitions.
