# 0009 — Discover report artifacts in tiers

**Status**: Accepted

## Context

Projects upload test reports under all kinds of names, alongside much larger
artifacts — failure videos, traces, build outputs. Downloading and sniffing
everything is robust but wasteful; trusting names alone misses reports uploaded
under an unexpected one.

## Decision

Per run (`fetchRun` in `src/artifacts/fetch.ts`):

1. List artifact names and sizes — no downloads.
2. Download name matches for `*report*`, `*result*`, `*junit*`, `*blob*`,
   `*mochawesome*`. A match whose compressed size already exceeds the
   extraction budget is skipped, and surfaced as oversized, _before_ download.
3. Only when a run has _no_ name match, download its remaining artifacts under
   `--max-artifact-mb` (default 100); the parse step's content sniff keeps only
   real reports.

Extraction is zip-slip-guarded and capped by a declared-size decompression
budget; a failure costs only that artifact, with a warning.

## Consequences

- Zero-config robustness at a small fraction of sniff-everything bandwidth;
  videos and traces never dominate collection.
- Oversized and expired candidates are counted and reported, never silently
  dropped.
- `--exclude-artifact` drops roll-up artifacts by glob before download, so a
  merged report cannot double-count per-cell results.
