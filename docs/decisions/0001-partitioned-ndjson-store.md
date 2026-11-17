# 0001 — Store events as month-partitioned NDJSON

**Status**: Accepted

## Context

Suitevitals has no server and no database: collected test results have to live
somewhere a user can inspect, diff, back up and commit. A single ever-growing
file would make every read pay for the whole history, and every append risk the
whole store.

## Decision

The source of truth is plain NDJSON, one file per repo per month:
`data/<owner>__<repo>/<YYYY-MM>.ndjson`. Each line is one event — one test, in
one run attempt, in one matrix cell — and every event carries `schema_version`
(0011). Events land in the partition of their run's start month.

## Consequences

- The data is readable with `cat`, `jq` and `grep`, and git-friendly.
- Reads can start, stop or skip by month, and retention (`prune`) and
  compression (`compact`, 0002) work on whole files.
- There is no index: reports stream every event in range (0003). A query layer
  over the same files is the scaling path (0004).
- The layout is a public contract (documented in `docs/output-reference.md`);
  changing it needs a migration story.
