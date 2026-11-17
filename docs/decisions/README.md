# Architecture Decision Records

Decisions here capture _why_ the codebase looks the way it does, so a future
change can weigh the original trade-off before unpicking it.

- [0001-partitioned-ndjson-store](0001-partitioned-ndjson-store.md) — store
  events as plain NDJSON at `data/<owner>__<repo>/<YYYY-MM>.ndjson`.
- [0002-zstd-closed-months](0002-zstd-closed-months.md) — `compact` zstd-compresses
  closed months; the current month stays uncompressed for cheap appends.
- [0003-streaming-aggregation](0003-streaming-aggregation.md) — reports stream
  events one line at a time into an in-process aggregator; no database.
- [0004-duckdb-parquet-growth-path](0004-duckdb-parquet-growth-path.md) —
  DuckDB / Parquet over the same files is the reserved scaling path.
- [0005-test-identity](0005-test-identity.md) — `id = hash(file + title_path)`
  with a normalized `file`; the matrix is a dimension, never identity.
- [0006-redacted-truncated-errors](0006-redacted-truncated-errors.md) — error
  messages are redacted and cut to their first line by default.
- [0007-stack-frame-fingerprint](0007-stack-frame-fingerprint.md) — cluster
  failures by a hash of normalized stack frames, not the message.
- [0008-one-transport-pluggable-token](0008-one-transport-pluggable-token.md) —
  one Octokit transport; the token comes from `--token`, `GITHUB_TOKEN` or `gh`.
- [0009-tiered-artifact-discovery](0009-tiered-artifact-discovery.md) — list,
  download name matches, and sniff the rest only when nothing matched.
- [0010-no-log-fallback](0010-no-log-fallback.md) — no log scraping; `doctor`
  shows how to upload reports instead.
- [0011-schema-versioning](0011-schema-versioning.md) — every event carries
  `schema_version`, and a `source` field is reserved.
- [0012-crash-safe-idempotent-collect](0012-crash-safe-idempotent-collect.md) —
  dedup by `(run_id, run_attempt, id, matrix)`, append before advancing the
  watermark, never pass a pending run, lock state and data.
- [0013-built-in-zlib-zstd](0013-built-in-zlib-zstd.md) — compress with
  `node:zlib` zstd instead of the native `@mongodb-js/zstd`.
- [0014-node-24-minimum](0014-node-24-minimum.md) — require Node.js 24 and test
  on 24 and 26.
- [0015-biome-over-eslint-prettier](0015-biome-over-eslint-prettier.md) — Biome
  for lint, format (Markdown included) and import order.
- [0016-rerun-lookback-and-attempt-attribution](0016-rerun-lookback-and-attempt-attribution.md)
  — re-list 48 hours back for re-runs and stamp each artifact's events with the
  attempt that uploaded it.
