# Architecture Overview

suitevitals is a TypeScript, pure-ESM Node.js CLI with no server and no test
instrumentation. It reads the test-report artifacts that GitHub Actions runs
already upload, normalizes them into monthly NDJSON files you own, and ranks
tests by flakiness from those files. GitHub API calls are confined to
`src/github/`, and the logic around them (windowing, filtering, parsing,
dedup, scoring) is pure and unit-tested.

## Entry Point

| Entry             | File                              | Purpose                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| `suitevitals` CLI | `dist/cli.js` (from `src/cli.ts`) | Registers the six subcommands and runs `runMain` (citty)     |
| `npm run dev`     | `src/cli.ts` via `tsx`            | Same CLI from source, for development (`npm run dev -- ...`) |

There is no library entry: `package.json` declares only `bin`, and only `dist/`
is published.

`src/cli.ts` reads the version from `package.json` and defines the `collect`,
`report`, `dashboard`, `compact`, `prune` and `doctor` subcommands, each from
`src/commands/`. Every command is wrapped by `withCleanErrors`: an error thrown
by a command prints as one `Error: <message>` line (control characters
replaced, red when color is supported) and sets `process.exitCode = 1`.
Setting `SUITEVITALS_DEBUG` prints the full error instead. See
[Error handling strategy](Technical-Design.md#error-handling-strategy).

## Pipeline

Two pipelines meet at the partition files: `collect` writes them, `report` and
`dashboard` read them.

```text
collect:  auth ─► lock ─► state ─► window ─► list runs ─► filter/classify/cap
                                                               │
          state.json ◄─ watermark ◄─ append (dedup, fsync) ◄─ parse ◄─ fetch + extract

report:   data/<owner>__<repo>/*.ndjson[.zst] ─► read ─► filter ─► aggregate ─► score/rank ─► render
```

### Collect

`collect` resolves its targets, authenticates once, takes its locks, then runs
`collectRepo` for each repo in turn:

1. **Targets** — `resolveTargets` (`src/collect/config.ts`) merges repeatable
   `--repo` flags and an optional `--config` file. Each setting resolves
   most-specific-wins: per-repo config value → CLI flag → config default →
   built-in. A repo named twice is collected once.
2. **Auth** — `createGitHubClient` resolves a token (`--token` →
   `GITHUB_TOKEN` → `gh auth token`) and builds the single Octokit transport
   with the throttling and retry plugins.
3. **Locks** — `<state-file>.lock` (always) and `<data-dir>/.lock` (except on
   `--dry-run`). See [State, Watermark and Idempotency](#state-watermark-and-idempotency).
4. **Window** — `computeWindow` (`src/collect/window.ts`) picks where new runs
   start: the stored watermark, `--hours-back` if that is earlier, or a 72-hour
   default on the first collect.
5. **List runs** — `listRunsSince` (`src/github/runs.ts`) lists runs by
   `created` range from `listingStart`, which reaches
   `--rerun-lookback-hours` (default 48) further back once the repo has a
   watermark. `selectRuns` (`src/collect/rerun.ts`) keeps runs inside the
   window, tracked pending runs, and lookback runs whose attempt is newer than
   the one already collected. Tracked pending runs the listing missed are
   re-fetched by id (`getRun`).
6. **Filter, classify, cap** — `filterRuns` (`src/collect/filter.ts`) drops
   runs by `--workflow` glob and `--exclude-trigger` events. `classifyRuns`
   splits the rest into completed and pending. `capRuns` keeps the oldest
   `--max-runs` completed runs and defers the newer ones.
7. **Fetch and extract** — `fetchReportArtifacts` (`src/artifacts/fetch.ts`)
   processes runs in a `p-limit` pool (`--concurrency`, default 5): list
   artifacts, partition them into tiers, download, and unzip into a temporary
   directory with `extractZipNested` (`src/artifacts/extract.ts`). Each
   extracted file is tagged with its artifact name and the run attempt that
   uploaded it.
8. **Parse** — `parseRunReports` (`src/collect/parse.ts`) reads each `.xml`,
   `.json` and `.jsonl` file, sniffs it with `detectAndParse`
   (`src/adapters/dispatch.ts`), and enriches each `ParsedTest` into a
   `TestEvent` with `buildEvent` (`src/events/event.ts`), using the artifact
   name as the default matrix cell (`src/collect/matrix.ts`).
9. **Append** — `appendEvents` (`src/store/ndjson.ts`) groups events by month,
   skips any whose dedup key already exists, and appends the rest with an
   fsync.
10. **Advance state** — `nextWatermark` (`src/collect/watermark.ts`) moves the
    watermark past the processed and excluded runs but not past a pending or
    deferred one; `saveState` writes `state.json` atomically.
11. **Summary** — each stage prints its counts as it finishes: runs found,
    artifacts downloaded / expired / oversized / failed / excluded, files
    parsed, events written and duplicates skipped.

`--dry-run` stops after step 7 without downloading, writing events or saving
state.

### Report and dashboard

1. **Read** — `readRepoEvents` (`src/report/read.ts`) is an async generator
   over a repo's partitions, oldest month first, one line at a time;
   `.ndjson.zst` months are decompressed transparently.
2. **Filter** — the command drops events outside `--since` (run start time),
   `--branch` (exact) and `--workflow` (glob, the same `matchesGlob` as
   `collect`).
3. **Aggregate** — an `Aggregator` (`src/report/aggregate.ts`) folds events
   into one `TestAggregate` per test `id`, or per `(id, matrix cell)` with
   `--by-matrix`. `dashboard` also turns on the per-test timeline.
   `--half-life` (default `14d`) weights each run by its age from the newest
   run (0019).
4. **Score and rank** — `rankTests` (`src/report/rank.ts`) scores each
   aggregate with `scoreTest` (`src/report/score.ts`) and splits them into
   eligible (at least `--min-runs` decisive runs) and below-threshold sets.
5. **Render** — `renderReport` / `renderReportJson` (`src/report/render.ts`)
   for `report`, `renderDashboard` (`src/report/dashboard.ts`) for
   `dashboard`, which writes one self-contained HTML file.

### Maintenance and onboarding

- `compact` (`src/store/compact.ts`) zstd-compresses every closed month into
  `<YYYY-MM>.ndjson.zst`.
- `prune` (`src/store/prune.ts`) deletes partition files older than
  `--keep-months`.
- `doctor` lists a repo's recent artifacts and manifests and, if no report
  artifact is uploaded, prints the reporter and `upload-artifact` fix for the
  detected framework (`src/doctor/diagnose.ts`).

Flags for every command are listed in
[API-Interface-Design.md](API-Interface-Design.md); the stored formats are in
[output-reference.md](output-reference.md).

## Data Flow

### `WorkflowRun` (`src/github/runs.ts`)

A GitHub workflow run reduced to what collection needs.

```ts
{
  run_id: 9981234,
  run_attempt: 2,                 // latest attempt; 1 when GitHub omits it
  status: "completed",            // "in_progress", "queued", ... → pending
  conclusion: "failure" | null,
  workflow: "Playwright Tests",   // run name, or the workflow id as a string
  branch: "main" | null,
  sha: "f3a91c2...",
  trigger: "push",                // the run's event
  created_at: "2026-06-10T07:00:14Z",
  run_started_at?: "2026-06-10T09:30:02Z", // when the latest attempt started
}
```

### `ArtifactMeta` and `ExtractedFile` (`src/github/artifacts.ts`, `src/artifacts/fetch.ts`)

```ts
ArtifactMeta  { id, name, size_bytes, created_at, expired }
ExtractedFile { path, artifact, attempt }  // absolute path on disk, artifact name, uploading attempt
RunReports    { run: WorkflowRun, files: ExtractedFile[] }
```

`partitionArtifacts` sorts a run's `ArtifactMeta[]` into `excluded`, `expired`,
`reports` (name matches) and `skipped` (everything else). The fetch stage
returns one `RunReports` per run that yielded at least one file, plus an
`ArtifactFetchSummary` of counts.

### `ParsedTest` (`src/events/event.ts`)

What every adapter emits: a test with no run context yet.

```ts
{
  file: "tests/e2e/webTables.spec.js",  // as the report wrote it; normalized later
  title_path: ["Web Tables", "should delete a record"],
  status: "passed" | "failed" | "skipped",  // the last attempt's status
  flaky: true,                          // passed after a failed attempt
  duration_ms: 2310,
  attempts: [
    { n: 1, status: "failed", duration_ms: 2100,
      error: { message: "Timed out ...", fingerprint: "e81b2d0c4a17" } },
    { n: 2, status: "passed", duration_ms: 2310 },
  ],
  matrix?: { project: "firefox" },      // set only when the report carries one
}
```

### `TestEvent` (`src/events/event.ts`)

`buildEvent` adds identity, run context and the matrix cell. One event is
stored per test, per run attempt, per matrix cell.

```ts
{
  ...ParsedTest,                  // with `file` normalized
  schema_version: 1,
  id: "a3f9c1d27b0e4f55",         // hash(file + title_path)
  framework: "junit" | "playwright" | "mochawesome",
  source: "artifact",
  run: { provider: "github", repo, run_id, run_attempt, workflow, branch, sha,
         trigger, started_at },   // started_at is the run's created_at
  matrix: { artifact: "results-firefox" }, // always present
  collected_at: "2026-06-10T09:12:00Z",
}
```

`run.run_attempt` is the attempt that uploaded the event's artifact, not
necessarily the run's latest attempt. The full field reference is in
[output-reference.md](output-reference.md).

### `TestAggregate` (`src/report/aggregate.ts`)

The raw flake signals for one test (or one test in one matrix cell), with no
scoring opinion.

| Field                              | Meaning                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `id`, `file`, `title_path`         | From the first event seen for the group                             |
| `framework`, `matrix?`             | `matrix` only with `--by-matrix`                                    |
| `totalRuns`                        | Events in the group                                                 |
| `passed`, `failed`, `skipped`      | Final status counts                                                 |
| `flakyRuns`                        | Events with `flaky: true` (passed after retry)                      |
| `retriedRuns`                      | Events with more than one attempt                                   |
| `flips`, `flipPairs`               | Pass↔fail transitions over push/schedule run pairs (0017)           |
| `distinctShas`, `intermittentShas` | `(sha, matrix cell)` buckets seen, and those with a pass and a fail |
| `fingerprints`                     | Distinct error fingerprints across all attempts                     |
| `firstSeen`, `lastSeen`            | Earliest and latest `run.started_at`                                |
| `timeline?`                        | Outcomes sorted by run start; only when the timeline is enabled     |
| `weighted`                         | The counts scoring reads, weighted by run age (0019)                |

### `ScoredTest` and `RankedTests` (`src/report/score.ts`, `src/report/rank.ts`)

```ts
FlakeScore  { score: 0..100, rawScore, confidence, eligible, eligibleRuns, signals: {
                retryFlakeRate, flipRate, intermittenceRate, diversity }, topSignal? }
ScoredTest  { aggregate: TestAggregate, score: FlakeScore }
RankedTests { eligible: ScoredTest[], belowThreshold: ScoredTest[] }
```

### `State` and `RepoState` (`src/state/state.ts`)

```json
{
  "schema_version": 1,
  "repos": {
    "octo-org/web-app": {
      "watermark": "2026-06-09T07:14:00Z",
      "pending_runs": [9981301],
      "rerun_attempts": { "9981100": 2 },
      "last_collected_at": "2026-06-10T09:12:00Z"
    }
  }
}
```

| Field               | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `watermark`         | `created_at` up to which runs are disposed of; the next window starts here    |
| `pending_runs`      | Ids of in-progress or queued runs, re-checked on the next collect             |
| `rerun_attempts`    | Highest attempt collected for recent re-runs (run id → attempt, only above 1) |
| `last_collected_at` | When the repo was last collected                                              |

### Flow Pattern

Data only moves forward. Adapters are pure `string → ParsedTest[]` functions;
they never see the run, the artifact or the file system. Enrichment
(`buildEvent`) is shared, so every format gets the same identity and run
context. The only writers are `appendEvents` (partitions), `saveState`
(`state.json`), `compactRepo` and `pruneRepo` (partition maintenance) and the
`dashboard` command (its HTML file). `report` and `dashboard` never write to
the partitions.

## State, Watermark and Idempotency

Re-running `collect` is always safe and writes nothing new. Four mechanisms
make that hold:

- **Dedup key.** Every event is keyed by `(run_id, run_attempt, id, matrix)`
  (`dedupKey`, `src/store/dedup.ts`). `appendEvents` reads the keys already in
  the month's `.ndjson` and `.ndjson.zst` files and skips matches, so a
  re-collected run writes zero events.
- **Append before state.** The append is fsynced, then the watermark advances
  and `state.json` is saved. A crash in between leaves the old watermark, so
  the next collect re-lists the same runs and the dedup absorbs the overlap.
  Nothing is skipped.
- **The watermark never passes unfinished work.** It advances to the newest
  `created_at` among processed and policy-excluded runs, is held at the
  earliest pending run created inside the scanned range, and never passes a
  run that `--max-runs` deferred. Pending runs are also tracked by id in
  `pending_runs`.
- **Single writer.** `<state-file>.lock` stops two `collect` processes from
  racing the read-keys → append sequence; `<data-dir>/.lock`, shared with
  `compact` and `prune`, stops a maintenance command from removing a file a
  collect is appending to.

State is per repo and saved after each repo, so a failure partway through a
multi-repo collect keeps the repos already done. The mechanics (lock breaking,
atomic writes, re-run attribution) are in [Technical-Design.md](Technical-Design.md);
the reasoning is in the decision records under [decisions/](decisions/).

## File Map

| File                              | Responsibility                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `src/cli.ts`                      | citty entry; registers subcommands; `withCleanErrors` one-line error handling       |
| `src/colors.ts`                   | Semantic `Palette` over picocolors, `colorSupported`, `terminalSafe`                |
| `src/commands/collect.ts`         | `collect`: flag parsing, locks, signal handling, per-repo `collectRepo`, summaries  |
| `src/commands/report.ts`          | `report`: stream, filter, aggregate, rank, terminal table or JSON                   |
| `src/commands/dashboard.ts`       | `dashboard`: same pipeline with timelines, writes the HTML file                     |
| `src/commands/compact.ts`         | `compact`: zstd-compress closed months under the data-dir lock                      |
| `src/commands/prune.ts`           | `prune`: delete months older than `--keep-months` under the data-dir lock           |
| `src/commands/doctor.ts`          | `doctor`: gather artifact names and manifests from the API, print the diagnosis     |
| `src/commands/repo-flags.ts`      | Reads every `--repo` from raw argv (citty keeps only the last)                      |
| `src/collect/config.ts`           | `--config` parsing and validation; `resolveTargets` precedence merge                |
| `src/collect/window.ts`           | `computeWindow`: watermark / `--hours-back` / 72-hour default                       |
| `src/collect/rerun.ts`            | Re-run lookback: `listingStart`, `selectRuns`, `rerun_attempts` bookkeeping         |
| `src/collect/filter.ts`           | `matchesGlob`, `filterRuns`, `capRuns`, `watermarkDisposal`                         |
| `src/collect/matrix.ts`           | Matrix cell from the artifact name; `--matrix-from-artifact` compilation            |
| `src/collect/parse.ts`            | Walks extracted files, dispatches adapters, builds events, counts outcomes          |
| `src/collect/watermark.ts`        | `nextWatermark`                                                                     |
| `src/github/auth.ts`              | Token chain `--token` → `GITHUB_TOKEN` → `gh auth token` → `AuthError`              |
| `src/github/client.ts`            | The single Octokit transport with throttling/retry plugins and the quiet 404 logger |
| `src/github/repo.ts`              | `parseRepoRef` validation and `repoSlug`                                            |
| `src/github/runs.ts`              | `WorkflowRun`, windowed run listing, `getRun`, attempt starts, `classifyRuns`       |
| `src/github/artifacts.ts`         | `ArtifactMeta`, report-name patterns, `partitionArtifacts`, list and download       |
| `src/github/contents.ts`          | File reads, git-tree listing and presence probes for `doctor`                       |
| `src/artifacts/fetch.ts`          | Tiered discovery, attempt attribution, concurrent fetch, outcome folding            |
| `src/artifacts/extract.ts`        | fflate unzip with zip-slip guard, decompression budget, one nested level            |
| `src/adapters/dispatch.ts`        | `detectAndParse`: content sniff → adapter                                           |
| `src/adapters/junit.ts`           | JUnit XML (including Surefire retries)                                              |
| `src/adapters/playwright-blob.ts` | Playwright blob `report.jsonl` (teleReporter events)                                |
| `src/adapters/mochawesome.ts`     | Mochawesome JSON (Cypress/Mocha)                                                    |
| `src/events/event.ts`             | `ParsedTest`/`TestEvent` types, `testId`, `normalizeTestFile`, `buildEvent`         |
| `src/events/error.ts`             | Secret redaction, truncation, stack normalization and fingerprint                   |
| `src/store/partition.ts`          | Month of an event, `<owner>__<repo>` directory, partition path                      |
| `src/store/dedup.ts`              | `stableMatrix`, `dedupKey`                                                          |
| `src/store/ndjson.ts`             | Dedup-guarded fsynced append; `parseEventLine`                                      |
| `src/store/durable.ts`            | `writeFileDurable`, `syncDir`                                                       |
| `src/store/compress.ts`           | zstd via `node:zlib`; partition file naming; transparent read                       |
| `src/store/compact.ts`            | `compactRepo` (merge, dedup, atomic replace), `listRepoSlugs`                       |
| `src/store/prune.ts`              | `pruneCutoff`, `pruneRepo`                                                          |
| `src/state/state.ts`              | `State`/`RepoState`, `loadState`, atomic `saveState`                                |
| `src/state/lock.ts`               | Exclusive-create lock files, stale-lock breaking, owned release                     |
| `src/report/read.ts`              | Streaming partition reader with per-month both-forms dedup                          |
| `src/report/aggregate.ts`         | `Aggregator` and `TestAggregate`                                                    |
| `src/report/score.ts`             | `scoreTest`, weights, `DEFAULT_MIN_RUNS`                                            |
| `src/report/rank.ts`              | `rankTests`, `parseSince`                                                           |
| `src/report/explain.ts`           | `explainScore`: the `WHY` text for a score's top signal                             |
| `src/report/render.ts`            | Terminal table and `--json` output                                                  |
| `src/report/dashboard.ts`         | Self-contained HTML dashboard with sparklines                                       |
| `src/doctor/diagnose.ts`          | Framework detection, manifest path selection, per-framework fixes                   |
