# 0004 — Reserve DuckDB / Parquet as the scaling path

**Status**: Accepted (not yet implemented)

## Context

Streaming aggregation (0003) is the right default, but at some volume of repos
and history a columnar query engine will win. Choosing a storage format that
could only be scaled by migrating it would make that future expensive.

## Decision

Keep DuckDB (querying the NDJSON directly, or Parquet derived from it) as the
designed-in escape hatch over the same partitioned files (0001). Nothing in v1
depends on it, and no code path assumes it.

## Consequences

- Scaling up never requires migrating collected data: DuckDB reads NDJSON and
  zstd natively, and Parquet can be derived from the partitions at any time.
- The storage layout must stay something an off-the-shelf engine can read:
  newline-delimited JSON, stable field names, `schema_version` on every line.
- Until it is needed, it costs nothing — no dependency, no code.
