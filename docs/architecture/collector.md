# Collector

## CLI surface

```
suitevitals collect
  --repo <owner/name>     (repeatable)
  --config <path>         repos + per-repo overrides
  --hours-back <n>        explicit backfill window
  --concurrency <n>       default 5
  --workflow <glob>       only collect matching workflows (default: all)
  --exclude-trigger <l>   skip runs fired by these events (comma-separated)
  --max-runs <n>          cap completed runs per invocation, oldest first
  --rerun-lookback-hours  re-list this far back for re-runs (default 168, 0 disables)
  --max-artifact-mb <n>   default 100 (tier-3 sniff cap)
  --dry-run               show what would be fetched
  --full-errors
```

**Window logic:** with state, collect since the watermark; `--hours-back` can only widen that
window (the earlier of the two wins, dedup makes overlap safe) — never narrow it, or runs between
the watermark and `now - hoursBack` would be skipped while the watermark passed them; the first
run defaults to 72h with a hint about going wider.

**Backfill ceiling:** runs are listable far back, but artifacts expire per repo retention
(often 14–90 days). The summary must report `N runs had expired artifacts` — never thin out
silently.

## Pipeline (per repo)

1. **Load state** → watermark + `pending_runs`.
2. **List runs** — paginate runs newest-first; stop past the window; re-check `pending_runs`
   explicitly.
3. **Filter & classify** — `--workflow`/`--exclude-trigger` drop runs by policy (the watermark
   *may* pass those, or excluding a busy workflow would stall it forever); the rest classify as
   completed → collect, in-progress/queued → `pending_runs` (the watermark does not advance
   past them). `--max-runs` then caps the completed set oldest-first; the watermark never
   passes a deferred run, so the newer remainder is collected next invocation.
4. **Fetch artifacts** (tiered, [D9](decisions.md#d9--artifact-discovery-tiered)) into a temp
   dir; expired artifacts are counted and reported. A report match whose *compressed* size
   already exceeds the extraction budget is skipped (as oversized) before download, so it can
   never balloon memory. Extraction enforces a decompressed-size budget (default 500 MB,
   checked from the zip's declared entry sizes *before* inflating), so a zip bomb is counted
   as oversized and skipped, never inflated; any other extraction failure (corrupt or hostile
   archive) costs that one artifact, with a warning — download errors still abort the repo,
   since they are transient and the watermark has not advanced.
5. **Adapter dispatch** by sniffing extracted files: `<testsuites>` root → JUnit; JSON with
   `config` + `suites` → Playwright; JSON with `stats` + `results` → Mochawesome. A per-repo
   config override wins over sniffing. A candidate file that throws during read or parse is
   warned and skipped, never fatal.
6. **Normalize & append** events with dedup; the append is fsynced, and state is updated only
   after it succeeds. A single-writer lock (`<state-file>.lock`) rejects a concurrent collect
   on the same state file, so the read-keys → append sequence never races itself.
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
  `.ndjson.zst` transparently, so it is invisible to the rest of the tool. When a month exists
  in both forms (crash mid-compaction, late backfill), the merge de-duplicates by key — the
  reader's both-forms dedup only holds while two files coexist, so the merge must bake in no
  duplicates.
- `suitevitals prune --keep-months <n>` — **implemented**: retention. Deletes partition files
  (either form) for months older than the kept window; the current month always survives, and
  `--dry-run` previews. A later backfill over a pruned window re-collects it (the dedup keys
  were deleted with the files).
- `suitevitals doctor --repo <owner/name>` — **implemented**: inspects recent runs; if no report
  artifacts are uploaded, detects the framework from the repo's manifests and prints the exact
  reporter + `upload-artifact` YAML fix. Pure diagnosis (`src/doctor/diagnose.ts`) over signals
  gathered from the GitHub API — one git-trees listing covers monorepo `package.json` files
  (shallow, capped, `node_modules` excluded) and Java build files at any depth, with root-only
  probing as the fallback for huge/empty repos.

## Implementation status

The `collect` command currently authenticates (single Octokit transport, token chain per
[D8](decisions.md#d8--auth-one-transport-pluggable-token-resolution)), loads state, computes
the collection window (watermark / `--hours-back` / 72h default), lists workflow runs since
that window, classifies them into completed vs. pending, and for the completed runs performs
tiered artifact discovery ([D9](decisions.md#d9--artifact-discovery-tiered)): list
artifact names/sizes (tier 1), download the report-glob matches and extract them into a temp dir
(tier 2), and — only when a run has *no* name match — download and extract its remaining artifacts
under `--max-artifact-mb` (default 100) so a report uploaded under an unexpected name is still found
(tier 3); the parse step's content sniff discards anything that is not a report, and oversized
candidates are counted, never silently dropped. Expired artifacts are likewise counted.
`--dry-run` lists and partitions without downloading.

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
mochawesome) fall back to the collect-level default, which is **derived from the name of the
artifact the report came from** (`src/collect/matrix.ts`).

That fallback is load-bearing rather than cosmetic. The dedup key below includes `matrix`, so a
permanently empty one makes every matrix cell's result for a test share a key — the first written
wins and the rest are discarded as duplicates. A test failing only on Firefox is then undetectable.
Because a CI matrix job uploads its own artifact, the artifact name identifies the cell:
`--matrix-from-artifact` supplies a regex whose **named groups become the dimensions**, and without
one the cell is the opaque `{ artifact: <name> }` — a fact rather than an inference, and enough to
keep distinct cells distinct. Extraction therefore tags every file with its source artifact
(`ExtractedFile`), which the fetch layer previously discarded.

The counterpart is `--exclude-artifact`: a pipeline uploading both per-cell reports and a merged
roll-up of the same results would count every test twice, so the roll-up is dropped by name glob in
`partitionArtifacts` — before download, and counted in the summary rather than silently.

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
partway through keeps the repos already collected (D12, extended across the loop). One repo's
failure (revoked access, a deleted repo, an outage) is reported — with a non-zero exit code —
and the remaining repos still collect; the failed repo's watermark is untouched, so the next
collect simply retries it.

A hardening pass (2026-07-11) closed the robustness gaps a security scan surfaced: extraction
enforces the decompressed-size budget above (zip bombs are counted as oversized, never inflated);
redaction ([D6](decisions.md#d6--error-storage-redacted--truncated-by-default)) also covers
`user:pass@` URL credentials, bare JWTs, and PEM private-key blocks; a malformed partition line
is warn-and-skipped on read, append, and compact (compact keeps unparseable lines verbatim —
it deletes its sources, so it must never drop what it cannot parse) instead of failing the repo;
appends fsync before the watermark advances, making the
[D12](decisions.md#d12--crash-safety--idempotency) "durable append" literal; `collect` takes a
`<state-file>.lock` single-writer lock; repo refs reject `.`/`..` segments; and `doctor`
tolerates >1 MB manifests (the contents API returns `encoding: "none"` for those).

A second hardening pass (2026-07-18) closed what a full-project security review surfaced.
Report artifacts whose compressed size already exceeds the extraction budget are skipped (and
counted as oversized) *before* download; a corrupt or hostile archive, and an unparseable
report file, cost only that artifact or file (download errors still abort the repo — they are
transient, and aborting before the watermark advances is what makes them safe to retry); one
repo's failure no longer stops a multi-repo run. Tracked `pending_runs` are now genuinely
re-fetched by id, so a wide `--hours-back` window can no longer strand an old in-progress run
behind the watermark. `state.json` is written atomically (temp file + rename); a stale lock
whose recorded pid is gone is broken automatically, and SIGINT/SIGTERM release the lock before
exiting. The JUnit sniff is anchored to the document head (a JSON report merely quoting
`<testsuite` is never misrouted), and DOCTYPE-bearing JUnit documents parse with XML entity
expansion disabled (blocks quadratic entity amplification). The
[D6](decisions.md#d6--error-storage-redacted--truncated-by-default) truncation budget now caps
the kept first line too, and redaction also covers GitLab, npm, and OpenAI-style token shapes.
Matrix cells serialize as JSON inside dedup/grouping keys, so cell content (`,`, `=`) can never
make two different cells collide. CI runs with a read-only token and audits production
dependencies.

A functionality pass (2026-07-19) added the levers the review asked for: collect-time
`--workflow`/`--exclude-trigger` filters (`src/collect/filter.ts`, also per-repo/config-level
settings resolved most-specific-wins — and the security lever that keeps fork-PR artifacts out
entirely), a `--max-runs` oldest-first cap for bounded backfills, `--branch`/`--workflow`
filters on `report` and `dashboard`, the `prune` retention command, and monorepo-aware
`doctor`.

### Known gaps

Run listing filters by *creation* time (`created>=…`), and a GitHub re-run keeps the original
run's `created_at`, so the window past the watermark never shows a new attempt of an older run.
Listing therefore reaches `--rerun-lookback-hours` (default 168) behind the window start
(`src/collect/rerun.ts`); a run from that stretch is collected only when its `run_attempt` is
above the highest attempt already collected for it (`rerun_attempts` in state, kept only for
listed runs above attempt 1), so the lookback never re-downloads already-collected runs. A
re-run older than the lookback is still collected only by a `--hours-back` backfill covering
its creation date.

GitHub returns at most 1000 runs for a `created`-filtered listing, however many pages exist.
Listing queries explicit `created:start..end` ranges and halves any range whose `total_count`
exceeds the cap until every slice fits (`listRunsWindowed`), de-duping boundary runs by id —
paging a capped listing would stop at the newest 1000 and let the watermark pass the rest.

A partial re-run ("re-run failed jobs") carries the untouched jobs' artifacts over, so a run's
artifact list mixes attempts. Each artifact is attributed to the latest attempt that had started
when it was created (`attemptForArtifact`, one `GET …/attempts/{n}` per extra attempt, only for
re-run runs), and its events carry that attempt — never the run's current one, which would put
carried-over results under a second dedup key and double-count them.

The collector is **v1 feature-complete (M1–M5)**. M1 was the idempotent walking skeleton; M2 added
the Playwright blob and mochawesome adapters, live fetch progress, `p-limit` concurrency,
transport-level rate-limit backoff, and multi-repo config; M3 the streaming aggregation, flake
score, and `report` command; M4 the HTML `dashboard` and zstd `compact`; M5 the `doctor` command
and the tier-3 sniff fallback above.
