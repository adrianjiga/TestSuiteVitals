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
7. **Concurrency & rate limits** — one `p-limit` pool (default 5, `--concurrency`) fetches runs
   in parallel. Backoff is handled at the transport by GitHub's official `@octokit/plugin-throttling`
   (honors primary/secondary rate-limit headers and `Retry-After`, waits then retries up to 3×) and
   `@octokit/plugin-retry` (transient 5xx/network), so it covers every API call, not just downloads.
8. **Summary** — runs scanned / collected / deduped / pending / expired, oversized-artifact
   skips, events written, elapsed, rate-limit remaining.

## Other commands

- `suitevitals report` — **implemented**: streams the partitions, aggregates per-test flake
  signals, scores them, and prints a ranked terminal table (or `--json`), with the
  matrix-grouping option per [D5](decisions.md#d5--test-identity-hashfile--title_path),
  a `--min-runs` threshold, a `--since` window, and `--all`/`--limit`.
- `suitevitals dashboard` — **implemented**: renders the same ranking as a self-contained
  HTML "vital signs" monitor (inline CSS, zero runtime deps), one row per test with a heartbeat
  sparkline of recent run outcomes.
- `suitevitals compact` — **implemented**: zstd-compresses closed months
  ([D2](decisions.md#d2--compression-zstd-on-closed-months)); the reader and append-dedup read
  `.ndjson.zst` transparently, so it is invisible to the rest of the tool.
- `suitevitals doctor --repo <owner/name>` — **implemented**: inspects recent runs; if no report
  artifacts are uploaded, detects the framework from the repo's manifests and prints the exact
  reporter + `upload-artifact` YAML fix. Pure diagnosis (`src/doctor/diagnose.ts`) over signals
  gathered from the GitHub API.

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
so extraction recurses one nested level to surface the inner file. Runs are fetched in parallel
up to `--concurrency` (a `p-limit` pool, default 5), and `collect` prints live progress
(`Fetching artifacts: n/total run(s)…`) so long backfills never look hung. Each run is processed
into an isolated outcome and the outcomes are folded back in input order, so the summary and the
parsed-event order stay deterministic regardless of which download finishes first. The transport
(`client.ts`) hardens every API call with GitHub's official `throttling` (obeys primary/secondary
rate-limit headers, waits then retries) and `retry` (transient 5xx/network) plugins, so concurrency
never turns into rate-limit failures.

The extracted reports are then dispatched to a matching adapter by content sniff and parsed into
normalized events. Implemented adapters:

- **JUnit** (`<testsuites>`/`<testsuite>` root) — flat, one attempt per test; non-JUnit XML
  (e.g. TestNG's `testng-results.xml`) is skipped.
- **Playwright blob** (`report.jsonl` teleReporter stream) — builds the suite tree from
  `onProject`/`onBegin`, groups `onTestEnd` retries into `attempts[]`, and derives the **matrix**
  from the project name. This is what sharded Playwright CI uploads.
- **Mochawesome** (`stats` + `results` JSON) — Cypress/Mocha's per-spec report. Recursively walks
  the `suites`/`tests` tree, skipping the root node's title (the spec filename, not a describe).
  Flat per test (one attempt, never flaky), like JUnit; status comes from `pending`/`skipped` first,
  then `state`/`pass`/`fail`. No matrix dimension.

Failure messages are redacted and truncated
([D6](decisions.md#d6--error-storage-redacted--truncated-by-default), bypassed by `--full-errors`)
and fingerprinted from their normalized stack
([D7](decisions.md#d7--failure-clustering-stack-frame-fingerprint)). Adapters emit a shared
`ParsedTest` shape that a common builder enriches into a `TestEvent` with stable identity
(`id = hash(file + title_path)`, [D5](decisions.md#d5--test-identity-hashfile--title_path)). An
adapter may set a per-test `matrix` (Playwright's project); adapters without matrix info (JUnit,
mochawesome) fall back to the collect-level default.

Events are then appended to monthly NDJSON partitions
(`data/<owner>__<repo>/<YYYY-MM>.ndjson`, [D1](decisions.md#d1--source-of-truth-partitioned-ndjson)),
partitioned by the run's month so backfills land correctly. Append is dedup-guarded by the
`(run_id, run_attempt, id, matrix)` key ([D12](decisions.md#d12--crash-safety--idempotency)),
which both collapses within-run duplicates (e.g. Surefire's per-class `TEST-*.xml`) and makes
re-collection a no-op. The watermark advances **only after** the durable append, and never past
an in-progress run; in-progress/queued runs are also tracked by id in `pending_runs` for explicit
re-check. `--dry-run` skips all writes.

A single `collect` invocation can target several repos — repeated `--repo` flags, a `--config`
file, or both (`src/collect/config.ts`). Each config repo is a bare `owner/name` or an object
with per-repo `hoursBack`/`concurrency` overrides, plus config-level defaults. Settings resolve
most-specific-wins: per-repo value → CLI flag → config default → built-in; a repo named twice is
de-duplicated. The repos share one client, state file, and data dir and are collected in
sequence; state is keyed per repo (its own watermark), and is saved after each repo so a crash
partway through keeps the repos already collected (D12, extended across the loop).

The **M1 walking skeleton** is complete (idempotent end-to-end). **M2 is complete**: the
Playwright blob and mochawesome adapters, live fetch progress, `p-limit` concurrency,
transport-level rate-limit backoff, and multi-repo config have all landed. **M3 is complete**:
the `report` command streams the partitions, aggregates per-test flake signals, scores them,
and prints a ranked table (or `--json`). Next is M4 (HTML dashboard + `compact`).
