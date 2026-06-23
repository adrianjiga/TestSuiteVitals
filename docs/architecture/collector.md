# Collector

## CLI surface

```
suitevitals collect
  --repo <owner/name>     (repeatable)
  --config <path>         repos + per-repo overrides
  --hours-back <n>        explicit backfill window
  --concurrency <n>       default 5
  --workflow <glob>       default: all workflows
  --max-artifact-mb <n>   default 100 (tier-2 sniff guard)
  --dry-run               show what would be fetched
  --full-errors
```

**Window logic:** with state, collect since the watermark; `--hours-back` overrides to force a
wider backfill (dedup makes overlap safe); the first run defaults to 72h with a hint about
going wider.

**Backfill ceiling:** runs are listable far back, but artifacts expire per repo retention
(often 14–90 days). The summary must report `N runs had expired artifacts` — never thin out
silently.

## Pipeline (per repo)

1. **Load state** → watermark + `pending_runs`.
2. **List runs** — paginate runs newest-first; stop past the window; re-check `pending_runs`
   explicitly.
3. **Classify** — completed → collect; in-progress/queued → `pending_runs`; the watermark does
   not advance past them.
4. **Fetch artifacts** (tiered, [D9](decisions.md#d9--artifact-discovery-tiered)) into a temp
   dir; expired artifacts are counted and reported.
5. **Adapter dispatch** by sniffing extracted files: `<testsuites>` root → JUnit; JSON with
   `config` + `suites` → Playwright; JSON with `stats` + `results` → Mochawesome. A per-repo
   config override wins over sniffing.
6. **Normalize & append** events with dedup; update state only after the append succeeds.
7. **Concurrency & rate limits** — one `p-limit` pool (default 5) for all API calls and
   downloads; watch `x-ratelimit-remaining` with a buffer; on 403/429 honor `Retry-After`,
   else exponential backoff with jitter.
8. **Summary** — runs scanned / collected / deduped / pending / expired, oversized-artifact
   skips, events written, elapsed, rate-limit remaining.

## Other commands

- `suitevitals report` — terminal report ranked by flake score, with the matrix-grouping
  option per [D5](decisions.md#d5--test-identity-hashfile--title_path).
- `suitevitals dashboard` — self-contained HTML.
- `suitevitals compact` — zstd closed months ([D2](decisions.md#d2--compression-zstd-on-closed-months)).
- `suitevitals doctor <repo>` — inspects workflows; if no report artifacts are uploaded,
  prints the exact reporter + `upload-artifact` YAML fix for the detected framework.

## Implementation status

The `collect` command currently authenticates (single Octokit transport, token chain per
[D8](decisions.md#d8--auth-one-transport-pluggable-token-resolution)), loads state, computes
the collection window (watermark / `--hours-back` / 72h default), lists workflow runs since
that window, and classifies them into completed vs. pending. It stops before fetching
artifacts, and does not yet advance the watermark (that happens only after a durable append,
[D12](decisions.md#d12--crash-safety--idempotency)). Remaining M1 work: tier-1 artifact fetch
→ JUnit adapter → NDJSON append with dedup → summary.
