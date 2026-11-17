# 0011 — Version every event and reserve a `source` field

**Status**: Accepted

## Context

Collected data outlives the code that wrote it: partitions are kept for months,
committed, and re-read by every later version. Fields will be added and their
meaning refined, and any future degraded source (such as logs, 0010) must not
be mistaken for artifact data.

## Decision

Every event carries `schema_version` (currently 1), and a `source` field
(`"artifact"`; `"logs"` reserved) is present from the start. State carries its
own schema version.

## Consequences

- Old data stays parseable: readers can branch on `schema_version` rather than
  guess.
- Data from a degraded source would remain distinguishable and filterable.
- Every schema change must decide whether it bumps the version, and readers
  must keep handling every version ever written.
