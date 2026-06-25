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
that window, classifies them into completed vs. pending, and for the completed runs performs
tiered artifact discovery ([D9](decisions.md#d9--artifact-discovery-tiered) tiers 1–2): list
artifact names/sizes, then download the report-glob matches and extract them into a temp dir.
Expired artifacts are counted, never silently dropped. `--dry-run` lists and partitions
without downloading. The tier-3 sniff fallback is deferred to M5.

Blob artifacts are double-zipped (the artifact zip holds `report-*.zip` which holds the report),
so extraction recurses one nested level to surface the inner file. During the sequential fetch,
`collect` prints live progress (`Fetching artifacts: n/total run(s)…`) so long backfills never
look hung; `p-limit` concurrency to speed this up is a later M2 slice.

The extracted reports are then dispatched to a matching adapter by content sniff and parsed into
normalized events. Implemented adapters:

- **JUnit** (`<testsuites>`/`<testsuite>` root) — flat, one attempt per test; non-JUnit XML
  (e.g. TestNG's `testng-results.xml`) is skipped.
- **Playwright blob** (`report.jsonl` teleReporter stream) — builds the suite tree from
  `onProject`/`onBegin`, groups `onTestEnd` retries into `attempts[]`, and derives the **matrix**
  from the project name. This is what sharded Playwright CI uploads.

Failure messages are redacted and truncated
([D6](decisions.md#d6--error-storage-redacted--truncated-by-default), bypassed by `--full-errors`)
and fingerprinted from their normalized stack
([D7](decisions.md#d7--failure-clustering-stack-frame-fingerprint)). Adapters emit a shared
`ParsedTest` shape that a common builder enriches into a `TestEvent` with stable identity
(`id = hash(file + title_path)`, [D5](decisions.md#d5--test-identity-hashfile--title_path)). An
adapter may set a per-test `matrix` (Playwright's project); adapters without matrix info (JUnit)
fall back to the collect-level default. The Mochawesome adapter reuses this pipeline next.

Events are then appended to monthly NDJSON partitions
(`data/<owner>__<repo>/<YYYY-MM>.ndjson`, [D1](decisions.md#d1--source-of-truth-partitioned-ndjson)),
partitioned by the run's month so backfills land correctly. Append is dedup-guarded by the
`(run_id, run_attempt, id, matrix)` key ([D12](decisions.md#d12--crash-safety--idempotency)),
which both collapses within-run duplicates (e.g. Surefire's per-class `TEST-*.xml`) and makes
re-collection a no-op. The watermark advances **only after** the durable append, and never past
an in-progress run; in-progress/queued runs are also tracked by id in `pending_runs` for explicit
re-check. `--dry-run` skips all writes.

The **M1 walking skeleton** is complete (idempotent end-to-end). **M2** is in progress: the
Playwright blob adapter and live fetch progress have landed; remaining M2 work is the Mochawesome
adapter, multi-repo config, `p-limit` concurrency, and rate-limit backoff.
