# 0002 — Compress closed months with zstd

**Status**: Accepted

## Context

JSON events are verbose and repetitive, so partitions grow quickly on busy
repos. The current month is still being appended to on every `collect`;
compressing it would force a decompress-append-recompress cycle each time.

## Decision

A `compact` command compresses _closed_ months: `<YYYY-MM>.ndjson` becomes
`<YYYY-MM>.ndjson.zst` (zstd level 19, since a closed month is written once).
The current month stays uncompressed for cheap appends. All compression goes
through one chokepoint, `src/store/compress.ts`, which since 0013 uses the
built-in `node:zlib` zstd.

The reader and the append-dedup read either form transparently. `compact`
writes and fsyncs the `.zst` as a temp file, renames it into place, fsyncs the
directory, then deletes the raw file. If both forms of a month coexist (a crash
window, or a late backfill into a compacted month), the reader dedups by key
per month, and the next `compact` merges them into one `.zst`, deduping during
the merge. A line it cannot parse is kept verbatim, never dropped.

## Consequences

- Roughly 10x smaller closed months, with appends to the active month
  unaffected.
- `.zst` files are not `grep`-able directly; `zstd -dc` restores plain NDJSON.
- `compact` and `prune` share the data-directory lock with `collect` (0012), so
  neither can delete a partition mid-append.
