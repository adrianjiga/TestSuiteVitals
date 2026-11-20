# Technical Design

How suitevitals turns GitHub Actions artifacts into ranked flaky tests. The
collect side and the report side share only the partition files:

```text
github/runs.ts ─► collect/filter.ts ─► artifacts/fetch.ts ─► collect/parse.ts ─► store/ndjson.ts
 list runs by       policy filters,      tiered download,      sniff, adapter,      dedup, fsynced
 created range      classify, cap        extract, attribute    buildEvent           append

report/read.ts ─► report/aggregate.ts ─► report/score.ts + rank.ts ─► report/render.ts | dashboard.ts
 stream months       per-test signals        0–100 score, split          table, JSON or HTML
```

[Architecture.md](Architecture.md) has the stage list and the data shapes; this
document covers how each stage works and why.

## Run listing

### Collection window

`computeWindow(repoState, { hoursBack, now })` in `src/collect/window.ts`
returns the instant new runs start from, and where it came from:

| Situation                         | `since`                                | Source       |
| --------------------------------- | -------------------------------------- | ------------ |
| `--hours-back` and a watermark    | the earlier of the two                 | either       |
| `--hours-back` only               | `now - hoursBack`                      | `hours-back` |
| Watermark only                    | the watermark                          | `watermark`  |
| Neither (first collect of a repo) | `now - 72h` (`DEFAULT_BACKFILL_HOURS`) | `default`    |

`--hours-back` can only widen the window. Narrowing it would let runs between
the watermark and `now - hoursBack` go uncollected while the watermark moves
past them; widening is always safe because the dedup key absorbs the overlap.

### Created ranges and the 1000-result cap

GitHub's run listing filters by _creation_ time and returns at most 1000 runs
for a `created`-filtered query, however many pages exist. Paging such a listing
would stop at the newest 1000 and let the watermark pass the rest.

`listRunsWindowed(listRange, since, until)` in `src/github/runs.ts` therefore
queries explicit `created:<start>..<end>` ranges (inclusive at both ends). Each
range is paged at 100 per page; if any page reports `total_count > 1000`
(`RUN_LISTING_CAP`), the range is abandoned and replaced by its two halves.
Halving repeats until every slice fits. Runs are collected into a map by id, so
a run sitting exactly on a split boundary is counted once, and the result is
sorted newest first. If a range cannot be halved any further (more than 1000
runs created in the same millisecond), listing throws.

### Re-run lookback

A GitHub re-run keeps the original run's `created_at`, so a creation-time
window that starts at the watermark never shows a new attempt of an older run.
Listing therefore starts at `listingStart(windowSince, now, lookbackHours,
hasWatermark)`: `--rerun-lookback-hours` (default 48, `0` disables) before
now, when that is earlier than the window. A repo with no watermark lists only
its window.

`selectRuns` in `src/collect/rerun.ts` then keeps:

- every run created at or after the window start;
- every run whose id is in `pending_runs`;
- a run from the lookback stretch only when its `run_attempt` is above the
  highest attempt already collected for it (`rerun_attempts[run_id]`,
  defaulting to 1).

So a run that was never re-run, or whose latest attempt is already stored, is
not downloaded again. After the append, `nextCollectedAttempts` records the
highest collected _or filter-excluded_ attempt per run, keeps only entries
for runs still in the listing, and drops attempt-1 entries, so the map stays
small and an excluded re-run is not re-selected on every collect.

A repo whose state predates `rerun_attempts` is seeded once by
`initialCollectedAttempts`: a listed run created before the window, at attempt
2 or later, whose latest attempt started before `last_collected_at`, counts as
collected at that attempt. Its results are already stored, and collecting it
again would store carried-over results under new dedup keys.

### Pending runs

Runs that are not `completed` are pending. They are not collected, their ids
are saved in `pending_runs`, and the watermark is held so it does not pass
them (see [Watermark](#watermark)). On the next collect, tracked ids the
listing did not return (`missingPendingIds`) are re-fetched one by one with
`getRun`. A 404 means the run was deleted: it is dropped from tracking with a
warning instead of blocking every future collect.

### Policy filters and the run cap

`filterRuns` in `src/collect/filter.ts` splits runs into `included` and
`excluded`:

- `--workflow <glob>` keeps runs whose workflow name matches. `matchesGlob` is
  case-insensitive, `*` matches any span, and every other character is
  literal.
- `--exclude-trigger <events>` drops runs fired by those events.
  `--exclude-trigger pull_request` keeps fork-PR artifacts out of collection
  entirely.

Excluded runs are a _policy_ decision, so the watermark may pass them.
Otherwise a repo whose only recent activity is an excluded workflow would
re-list the same window forever.

`capRuns(completed, maxRuns)` implements `--max-runs`: it sorts completed runs
oldest first and processes the first `maxRuns`. The rest are deferred and
re-listed on the next collect.

### Watermark

`nextWatermark(prev, disposed, pending)` in `src/collect/watermark.ts`:

1. Start from the previous watermark.
2. Advance to the newest `created_at` among the disposed runs, if newer.
   `watermarkDisposal` defines disposed as the processed runs plus the
   excluded runs; when `--max-runs` deferred runs, only excluded runs at or
   below the newest processed run count, so the watermark never passes a
   deferred run.
3. If a pending run was created at or after `prev` but before the new
   watermark, pull the watermark back to the earliest such run.

The watermark never moves below `prev`. Pending runs older than `prev` are
handled by the id re-check, not by the window.

## Artifact discovery

`fetchReportArtifacts(fetcher, runs, workdir, options)` in
`src/artifacts/fetch.ts` takes an injectable `ArtifactFetcher` (`list`,
`download`, `attemptStarts`) so the orchestration is tested without the API.

### Tiers

For each run, `fetchRun`:

1. **Tier 1 — list.** `listRunArtifacts` returns names, sizes, creation times
   and the expired flag. Nothing is downloaded.
2. **Partition.** `partitionArtifacts(artifacts, excludeGlobs)` checks, in
   order: `--exclude-artifact` globs → `excluded`; expired blobs → `expired`;
   names containing `report`, `result`, `junit`, `blob` or `mochawesome`
   (case-insensitive) → `reports`; everything else → `skipped`.
3. **Tier 2 — report-name matches.** Each match is downloaded unless its
   _compressed_ size already exceeds the extraction budget (500 MB,
   `DEFAULT_MAX_EXTRACT_MB`); such an artifact could only fail that budget
   after an unbounded in-memory download, so it is counted as oversized and
   skipped.
4. **Tier 3 — sniff.** Only when the run has _no_ report-name match, every
   `skipped` artifact up to `--max-artifact-mb` (default 100) is downloaded and
   extracted too. Larger ones are counted as oversized. The content sniff in
   the parse step discards whatever is not a report, so a report uploaded under
   an unexpected name is still found, while failure videos and traces do not
   dominate bandwidth.

Expired, excluded, oversized, failed, sniffed and skipped artifacts are all
counted in `ArtifactFetchSummary` and printed; none is dropped silently.
`--dry-run` lists and partitions but downloads nothing.

### Attempt attribution

A partial re-run ("re-run failed jobs") carries the untouched jobs' artifacts
over, so one run's artifact list mixes attempts. If a run is at attempt 2 or
later and has candidates, `listAttemptStarts` builds the start time of each
attempt: attempt 1 is the run's `created_at`, and each later attempt costs one
`GET …/attempts/{n}`. `attemptForArtifact(created_at, starts)` assigns each
artifact the latest attempt that had started when it was created. An artifact
with no creation time gets the run's current attempt.

An artifact whose attempt is at or below the run's already-collected attempt
is skipped before download and counted as `collectedArtifacts`. The attempt is
carried on each `ExtractedFile` and becomes the event's `run.run_attempt`;
stamping carried-over results with the run's current attempt would store them
a second time under a different dedup key.

### Concurrency and rate limits

Runs are fetched through a `p-limit` pool of `--concurrency` (default 5). Each
run is processed into an isolated `RunOutcome`, and `foldOutcomes` combines
them in input order, so the summary and the event order do not depend on which
download finishes first. The `onProgress` callback drives the live
`Fetching artifacts: n/total run(s)…` line on stderr (rewritten in place on a
TTY, printed at milestones otherwise).

Backoff lives in the transport (`src/github/client.ts`), so it covers every API
call: `@octokit/plugin-throttling` honours primary and secondary rate-limit
responses, warns, waits and retries up to 3 times; `@octokit/plugin-retry`
retries transient 5xx and network errors.

### Extraction

`extractZipNested(zip, destDir, maxDepth = 2, maxBytes)` in
`src/artifacts/extract.ts` unzips with fflate's `unzipSync` into
`<tmpdir>/suitevitals-*/<run_id>/<artifact_id>/`. The temporary directory is
removed when the repo finishes, whether it succeeds or fails.

- **Zip-slip.** `safeJoin` normalizes each entry path against the destination
  and throws if it escapes it (`../`, absolute paths).
- **Decompression budget.** An fflate entry filter adds each entry's
  _declared_ uncompressed size to a running total and throws
  `ArchiveTooLargeError` once it passes the budget, before that entry is
  inflated. The total is shared by the outer archive and every nested archive
  in it, so nesting cannot multiply the budget.
- **Nesting.** Playwright blob artifacts are double-zipped (the artifact holds
  `report-*.zip`, which holds `report.jsonl`). Each extracted `.zip` is
  extracted once more into `<file>.extracted`. A nested entry that is not a
  readable zip is kept as a plain file; a nested budget overflow fails the
  whole artifact.
- Directory entries and empty entries are skipped.

## Report adapters

### Sniffing

`parseRunReports` in `src/collect/parse.ts` considers only files ending in
`.xml`, `.json` or `.jsonl`, reads each one as UTF-8, and calls
`detectAndParse(content, { fullErrors })`. The first sniff that matches wins:

| Order | Adapter         | Sniff (on the head of the file)                                                                                     |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1     | JUnit           | First 4096 chars: optional BOM, XML prolog, comments and DOCTYPE, then a `<testsuites` or `<testsuite` root element |
| 2     | Playwright blob | First 1000 chars contain `"method":"onConfigure"`, `onBlobReportMetadata`, `onProject` or `onBegin`                 |
| 3     | Mochawesome     | First 2000 chars contain both `"passPercent":` and `"testsRegistered":`                                             |

A file that matches no sniff is ignored. The JUnit sniff is anchored to the
document head because JUnit is tried first: a JSON report that merely quotes
`<testsuite` in an error message must not be parsed as XML and lose its tests.
Adapters are pure `string → ParsedTest[]` functions; a new format is a new
adapter plus a line in `detectAndParse`.

### JUnit (`src/adapters/junit.ts`)

Parsed with fast-xml-parser. Suites are collected at any depth under a
`<testsuites>` root or a lone `<testsuite>`; an inner suite without `file`
inherits the enclosing suite's.

- **File.** `testcase@file` → `testsuite@file` → `classname` →
  `testsuite@name` → `"unknown"`. `classname` ranks above the suite name
  because the suite name is a run label (TestNG/Surefire writes `TestSuite`,
  `UI Tests` or the class name for the same test depending on how it ran), and
  `file` feeds identity.
- **Title path.** `[classname, name]`, or `[name]` when the classname is
  missing or already used as the file.
- **Status.** A `<skipped>` child → skipped; any `<failure>`, `<error>`,
  `<rerunFailure>` or `<rerunError>` → failed; otherwise passed.
- **Surefire retries** (`rerunFailingTestsCount`). For a passing test, each
  `<flakyFailure>`/`<flakyError>` becomes a failed attempt before the final
  pass, and the test is flaky. For a failing test, the `<failure>`/`<error>`
  is attempt 1 and each `<rerunFailure>`/`<rerunError>` a further failed
  attempt. Otherwise there is one attempt.
- **DOCTYPE.** A document containing `<!DOCTYPE` is parsed with entity
  processing turned off. fast-xml-parser blocks recursive entities but one long
  entity referenced many times still expands quadratically; references stay as
  literal `&name;` text instead.

Non-JUnit XML such as TestNG's `testng-results.xml` fails the sniff and is
skipped.

### Playwright blob (`src/adapters/playwright-blob.ts`)

Reads `report.jsonl`, the teleReporter event stream a sharded Playwright run
uploads. Lines that are not valid JSON are skipped.

- `onProject` events carry the suite tree: each file suite's `entries` are
  walked, describe titles accumulate into the title path, and every test node
  is indexed by `testId` with its file (`location.file`) and the matrix cell
  `{ project: <project name> }`.
- `onTestEnd` events carry one result per retry. They are grouped by
  `testId`, sorted by `retry`, and become `attempts[]` with `n = retry + 1`.
- Status is judged against the test's `expectedStatus`, as Playwright does: a
  `test.fail()` test that fails is passed, and one that unexpectedly passes is
  failed. A skipped result or expected status is skipped.
- The test's status is its last attempt's, `flaky` is "passed after a failed
  attempt", and `duration_ms` is the last attempt's. The first error of a
  failed attempt is used, with ANSI color codes stripped.

### Mochawesome (`src/adapters/mochawesome.ts`)

Parses the Cypress/Mocha per-spec JSON. For each `results[]` entry the file is
`file` (relative) in preference to `fullFile` (absolute). The `suites`/`tests`
tree is walked recursively; the root suite's title is the spec filename, not a
describe, and is left out of the title path. Status checks `pending`/`skipped`
first, then `state`/`fail`, then `state`/`pass`; anything else is skipped.
Each test has exactly one attempt and is never flaky. Error stack comes from
`estack`, then `stack`.

### Matrix cell

Playwright sets a per-test `matrix` from the project name. JUnit and
Mochawesome carry none, so `buildEvent` falls back to the cell derived from
the artifact the file came from (`matrixForArtifact` in
`src/collect/matrix.ts`):

- With `--matrix-from-artifact <regex>`, the named groups that matched become
  the dimensions (`results-(?<browser>[^-]+)` → `{ browser: "firefox" }`).
  Optional groups that did not participate are omitted. The pattern must
  compile and declare at least one named group. A pattern in a `--config` file
  is checked when the file is parsed; a `--matrix-from-artifact` flag is
  compiled when the repo's reports are parsed.
- Without a pattern, or when the pattern does not match an artifact name, the
  cell is `{ artifact: <name> }`.

This is load-bearing: the dedup key includes the matrix, so an empty matrix
would give every cell's result for a test the same key, keep the first and drop
the rest. A failure on only one browser would never be stored.

## Event identity

`buildEvent(test, context)` in `src/events/event.ts` normalizes the file, then
computes:

```text
id = sha256(file + "\0" + title_path.join("\0")).hex.slice(0, 16)
```

The NUL separator keeps segment boundaries unambiguous. The matrix is never
part of `id` (decision 0005): one test has one history, and `--by-matrix` is a
grouping applied at report time, so toggling it never orphans data.

`normalizeTestFile` turns `\` into `/` and strips a GitHub Actions workspace
root of the form `<root>/<repo>/<repo>/`, where `<root>` is one of:

| Runner         | Root                           |
| -------------- | ------------------------------ |
| Hosted Linux   | `/home/runner/work`            |
| Hosted macOS   | `/Users/runner/work`           |
| Hosted Windows | `<drive>:/a` (after `\` → `/`) |
| Container job  | `/__w`                         |
| Self-hosted    | any path ending in `/_work`    |

So an emitter that writes absolute or OS-native paths still gives a test the
same id on every runner. Relative paths and Java class names are unchanged.
Because an identity change re-keys history with no migration path, any change
to how an adapter resolves `file` or `title_path` means deleting and
re-collecting the affected repo's partitions.

## Storage

### Partitions

Events live in `data/<owner>__<repo>/<YYYY-MM>.ndjson` (`partitionPath`,
`src/store/partition.ts`). The month comes from `run.started_at`, which is the
run's `created_at`, so a backfill lands in the month the run happened, not the
month it was collected. `parseRepoRef` only accepts `[A-Za-z0-9._-]` segments
and rejects `.` and `..`, because the repo name becomes a directory name.

### Dedup and append

`dedupKey(event)` in `src/store/dedup.ts` joins `run_id`, `run_attempt`, `id`
and `stableMatrix(matrix)` with NUL. `stableMatrix` serializes the cell as JSON
of its key-sorted `[key, value]` pairs, so key order never matters and cell
content (`,`, `=`) can never make two cells collide. The same serialization is
the grouping key in the `Aggregator`.

`appendEvents(dataDir, slug, events)` in `src/store/ndjson.ts`, per month:

1. Read the keys already stored, from `<month>.ndjson` (streamed line by line)
   and `<month>.ndjson.zst` (decompressed whole) if present.
2. Skip every event whose key is stored or already appeared in this batch
   (Surefire's per-class `TEST-*.xml` files can repeat a test within one run).
3. Append the remaining lines with one write to a file opened in append mode,
   `fsync` the file, then `fsync` its directory (`syncDir`).

A line that does not parse as JSON (a torn write, a hand edit) is skipped with
a warning naming the file, both here and in the reader, so one bad line costs
one record rather than every future `collect` and `report` for the repo.

### Reading

`readRepoEvents(dataDir, slug)` in `src/report/read.ts` groups the repo's
files by month and yields months in order. A month with one file streams it
directly (or decompresses it, for `.zst`). A month with both forms — a crash
mid-compaction, or a late backfill into a compacted month — is read file by
file with a per-month `Set` of keys, so overlapping events count once while
memory stays bounded by one month.

## Compaction and prune

### `compact`

`compactRepo(dataDir, slug, currentMonth)` in `src/store/compact.ts` handles
every month strictly before the current UTC month that still has a raw
`.ndjson` file; months that are only `.ndjson.zst` are already done, and the
current month stays uncompressed so appends stay cheap.

1. **Merge.** A month with one file passes through unparsed. A month with both
   forms is merged line by line, deduped by key (first occurrence wins, as in
   the reader). The merge must bake in no duplicates, because once only one
   file exists the reader no longer dedups. A line that cannot be parsed is
   kept verbatim: compaction deletes its sources, so it never drops data it
   cannot read.
2. **Compress.** `compressPartition` in `src/store/compress.ts` uses
   `node:zlib`'s built-in zstd at level 19; closed months are written once, so
   ratio is worth the CPU.
3. **Replace.** The output is written to `<month>.ndjson.zst.tmp` and fsynced,
   renamed over `<month>.ndjson.zst`, the directory is fsynced, and only then
   is the raw `.ndjson` removed. A crash at any point leaves either the old
   files or both forms, which the reader handles.

With no `--repo`, every `<owner>__<repo>` directory in the data dir is
compacted. The command runs under the data-dir lock.

### `prune`

`pruneCutoff(currentMonth, keepMonths)` returns the oldest month kept, counting
the current month as one (`--keep-months 1` keeps only the current month).
`pruneRepo` deletes files for months strictly before the cutoff, in either
form, and touches nothing that is not a recognized partition filename.
`--dry-run` lists what would go. A later `collect --hours-back` over a pruned
window collects it again, since its dedup keys were deleted with the files, as
long as GitHub still has the artifacts. `prune` also runs under the data-dir
lock.

## Locking and crash safety

### Lock files

`acquireLock(path)` in `src/state/lock.ts` creates the lock file with `open(…,
"wx")` (exclusive create) and writes `<pid>\n<random UUID>\n`. It returns a
release function that deletes the file only while its content is still this
process's pid and token, so it never removes a successor's lock.

| Lock                | Taken by                                        |
| ------------------- | ----------------------------------------------- |
| `<state-file>.lock` | `collect` (including `--dry-run`)               |
| `<data-dir>/.lock`  | `collect` (not `--dry-run`), `compact`, `prune` |

`report` and `dashboard` take no lock.

When the file already exists, the holder pid on its first line decides:

- **Live pid** (or `EPERM` from `process.kill(pid, 0)`, which means alive but
  another user's) → `LockError`: another process appears to be running.
- **Dead pid** → stale. `breakStaleLock` renames the lock aside to a unique
  name (atomic), re-reads the holder from the moved file, and deletes it if it
  still names the dead pid. If the moved file names someone else, a live lock
  was taken by mistake: it is copied back with an exclusive copy, or a
  `LockError` is raised if that fails. Acquisition then retries.
- **Empty file** (a crash between create and write) → stale once older than 5
  seconds.

Breaking a stale lock prints a warning. Acquisition gives up with a
`LockError` after 3 retries.

### Signals

`collect` installs one-shot `SIGINT` and `SIGTERM` handlers that release both
locks and exit with 130 or 143. Without them Node would die on the signal
without unwinding, leaving the lock to the stale-pid check.

### Durable writes

- **Appends** are fsynced, with their directory, before the watermark moves.
- **`state.json`** is written by `saveState` to `<state-file>.tmp` with
  `writeFileDurable` (write, fsync, close), renamed into place, and the
  directory fsynced. `loadState` treats a corrupt file as fatal, so a torn
  write must never be visible; losing the newest state is safe, because the
  next collect re-collects and dedups.
- **Compaction** uses the same temp-file, rename, directory-fsync sequence.
- `syncDir` ignores the errors Windows returns for opening or syncing a
  directory.

## Flake scoring

### Aggregation

`Aggregator.add(event)` in `src/report/aggregate.ts` folds one event at a time,
so the event history is never held in memory: one entry per test, plus a
bucket per commit and a small flip entry per push/schedule run. Groups are keyed by `id`, or by
`id` plus `stableMatrix(matrix)` with `--by-matrix`. Intermittence buckets are
always keyed by `(sha, matrix cell)`, even when cells are collapsed, so a test
that passes on Chrome and fails on Firefox at the same commit is not counted as
intermittent. `fingerprints` counts distinct error fingerprints across every
attempt, not just the final one. Every passed or failed `push` and `schedule`
event also adds `(started_at, run_attempt, failed)` to a sequence per
`(branch, matrix cell)`; at the end each sequence is sorted and its pass↔fail
transitions become `flips` over `flipPairs` consecutive pairs (0017). Pull
request runs are left out, since the code changes between them. With `timeline: true` (dashboard only), each
event also records `(started_at, outcome)` where a flaky pass is its own
outcome; the list is sorted by time at the end.

### Score

`scoreTest(aggregate, { minRuns })` in `src/report/score.ts`. Flaky means
_inconsistent_: a test that always passes, or always fails the same way, fires
none of the signals and scores 0.

```text
eligibleRuns      = passed + failed                     (skips excluded)
retryFlakeRate    = flakyRuns        / eligibleRuns
intermittenceRate = intermittentShas / distinctShas
flipRate          = min(1, 3 × flips / flipPairs)
diversity         = min(fingerprints - 1, 3) / 3        (0 for 0 or 1 fingerprint)

raw        = 0.35·retryFlakeRate + 0.30·flipRate
           + 0.20·intermittenceRate + 0.15·diversity
confidence = eligibleRuns / (eligibleRuns + 5)

rawScore = round(100 × raw)
score    = round(100 × raw × confidence)
```

Every ratio is 0 when its denominator is 0. Diversity counts only failure modes
beyond the first and saturates at 4 distinct fingerprints. Random failure at
rate p flips 2p(1−p) of the time, so the ×3 scale saturates flip rate from
about 20% random failure, and a test that broke once and was fixed stays near 0. Confidence
shrinks small samples toward 0 (0018): a test keeps half its raw score at 5
runs and 89% at 40, so 1 bad run out of 5 ranks below 20 out of 100. Its prior
strength is fixed, not tied to `minRuns`. `eligible` is
`eligibleRuns >= minRuns` (default 5), a display filter: a test below it still
gets a score but is set aside.

### Ranking

`rankTests` scores every aggregate, splits eligible from below-threshold, and
sorts each list by score descending, then by `eligibleRuns` descending (more
evidence first), then by `id` for a stable order.

`parseSince` accepts `Nd`, `Nh` or an ISO date/timestamp and throws on anything
else, so a typo never silently widens the window.

## Report and dashboard rendering

### Terminal table

`renderReport(ranked, meta, { limit, all }, palette)` in `src/report/render.ts`
prints a header, the top `--limit` (default 20) eligible tests, and either the
below-threshold tests (`--all`) or a one-line count of them. Columns are score,
test label (`file › describe › test`, plus `[k=v,…]` with `--by-matrix`,
truncated to 46 characters with `…`), eligible runs, retry %, intermittent /
distinct commits, and failure modes.

Each column is padded to its visible width _before_ color is applied, so ANSI
codes never break alignment. The palette (`src/colors.ts`) is semantic: scores
of 50 or more are bold red, 20 or more yellow, lower dim; a signal column is
yellow when non-zero. `createPalette(colorSupported)` follows picocolors'
TTY / `NO_COLOR` / `FORCE_COLOR` detection, and a disabled palette returns text
unchanged, so rendering is pure and the tests assert on plain output.

`--json` (`renderReportJson`) prints every scored test, eligible first, and is
never colored.

### Dashboard

`renderDashboard(ranked, meta)` in `src/report/dashboard.ts` returns one HTML
document with inline CSS and no scripts or external requests. Each row shows
the score, the test name (the last title segment leads; file and suites follow
dimmed; the full label is the tooltip), a sparkline of the latest 24 outcomes
(bar height and color per passed / flaky / failed / skipped), the three signal
columns, and a status: `flaky` (≥ 50), `unstable` (≥ 20), `watch` (> 0),
`healthy` (0), or `low data` when below `--min-runs`. Every artifact-derived
string goes through `esc`, which escapes `& < > " '`.

### Terminal safety

Test names, file paths, artifact names and error messages come from artifacts,
which anyone who can push a workflow controls. `terminalSafe` in
`src/colors.ts` replaces tab, newline and carriage return with a space and
every other C0 or C1 control character (including ESC) with U+FFFD. It is
applied to report labels, `doctor`'s matched artifact names, skipped-artifact
and skipped-file warnings, per-repo collect failures and the `Error:` line, so
a crafted name cannot move the cursor or rewrite the terminal.

## Error redaction and fingerprinting

### Redaction and truncation

`makeTestError({ message, stack }, options)` in `src/events/error.ts` stores a
redacted, truncated message plus a fingerprint. `redactSecrets` replaces, in
order:

- PEM private-key blocks;
- token shapes: GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
  `github_pat_`), Slack (`xox?-`), AWS access keys (`AKIA…`), GitLab
  (`glpat-`), npm (`npm_`), OpenAI-style `sk-`, Stripe
  (`sk_`/`rk_`/`pk_` + `live`/`test`) and Google API keys (`AIza…`);
- bare JWTs (`eyJ….….…`);
- `user:pass@` credentials in a URL authority;
- `Bearer` / `Basic` authorization values;
- secret-named CLI flags followed by a value (`--password hunter2`);
- secret-named keys in `key=value`, `key: value` and JSON `"key": "value"`
  forms, with quoted values (including escaped quotes) kept whole;
- every query-string value (`?x=…`, `&y=…`).

`truncate` then applies the 400-character budget (`DEFAULT_ERROR_LIMIT`): a
longer message keeps only its first line, itself capped at 400 characters, and
gets ` …[truncated]`. The cap holds even when the bloat is one huge line.
`--full-errors` bypasses both redaction and truncation.

### Fingerprint

`fingerprint(stack)` hashes the normalized stack (or the message when there is
no stack) with SHA-256 and keeps 12 hex characters. `normalizeStack` masks
ISO timestamps, hex addresses, file paths and `:line:col` numbers, then
collapses whitespace. Two failures with the same shape on different machines,
lines or times share a fingerprint, which is what `fingerprints` in the
aggregate counts. The fingerprint is computed from the original text, so it is
independent of redaction and truncation.

## `doctor`

`doctor` (`src/commands/doctor.ts`) gathers signals from the API and passes
them to the pure `diagnose` in `src/doctor/diagnose.ts`:

1. The newest 10 completed runs from the last 30 days, and every artifact name
   they uploaded.
2. One recursive git-tree listing of the default branch (`listRepoTree`). From
   it, `packageJsonPaths` picks up to 5 `package.json` files at most 3 path
   segments deep, shallowest first, never under `node_modules`, and
   `hasJavaBuildFile` looks for `pom.xml`, `build.gradle` or
   `build.gradle.kts` anywhere. When the tree is unavailable (404, 409 for an
   empty repo, or truncated for a huge one), it falls back to the root
   `package.json` and root build files.
3. `detectFramework` unions `dependencies` and `devDependencies` across the
   manifests and checks `@playwright/test`, `cypress`, `vitest`, `jest`,
   `mocha` in that order, then a Java build file. An unparseable manifest is
   skipped. A manifest over about 1 MB (returned with `encoding: "none"`) is
   treated as unreadable.

If any artifact name matches the report patterns, `doctor` reports success.
Otherwise it prints the reporter setup steps and `upload-artifact` YAML for the
detected framework. The transport's quiet logger drops Octokit's automatic
`… - 404 with id …` line, so expected 404s from these probes do not clutter
the output.

## Error handling strategy

Content problems are deterministic — retrying returns the same bytes — so they
cost only the artifact, file or line involved. Transport problems are
transient, so they abort the repo _before_ its watermark moves, which makes the
next collect a clean retry.

| Situation                                           | Behaviour                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| Artifact expired                                    | Counted in the summary, not downloaded                                          |
| Report match larger than the extraction budget      | Counted as oversized, not downloaded                                            |
| Tier-3 candidate larger than `--max-artifact-mb`    | Counted as oversized, not downloaded                                            |
| Archive expands past the extraction budget          | Counted as oversized, artifact skipped                                          |
| Corrupt archive, zip-slip entry, unwritable entry   | Warning, artifact skipped, counted as failed                                    |
| Report file unreadable or throws while parsing      | Warning, file skipped, counted as failed                                        |
| Malformed Playwright JSONL line                     | Line skipped silently                                                           |
| Malformed partition line                            | Warning, line skipped (kept verbatim by `compact`)                              |
| Tracked pending run returns 404                     | Warning, dropped from `pending_runs`                                            |
| Download or listing error (after transport retries) | That repo aborts with `[owner/repo] collect failed: …`; others continue; exit 1 |
| No token from any source                            | The `AuthError` guidance is printed; exit 1                                     |
| Lock held by a live process                         | `Error: Another suitevitals process appears to be running …`; exit 1            |
| Invalid flag value or config file                   | `Error: Invalid … ` before any network work; exit 1                             |
| Corrupt `state.json`                                | `Error: …`; exit 1 (never silently reset)                                       |
| `report`/`dashboard` with no stored events          | `Error: No collected events for …` naming the resolved directory; exit 1        |
| `report`/`dashboard` filters match nothing          | A notice (or `[]` with `--json`); exit 0                                        |
| Missing required flag or unknown subcommand         | citty prints usage and the message; exit 1                                      |
| `SIGINT` / `SIGTERM` during `collect`               | Locks released; exit 130 / 143                                                  |

### Command errors

`withCleanErrors` in `src/cli.ts` wraps every command: any error it throws is
printed as one red `Error: <message>` line, passed through `terminalSafe`, and
`process.exitCode` is set to 1 instead of printing a stack trace. Setting
`SUITEVITALS_DEBUG` to any non-empty value prints the full error object.
Inside `collect`, a failing repo is caught per repo so the rest of the fleet
still runs; the command finishes with exit code 1 and a count of failed repos
in the final summary when more than one repo was targeted.

## Known issues

- **Three-process stale-lock race.** Breaking a stale lock is rename-aside,
  check, then restore, which is safe for two contenders. With three processes
  starting at once over a stale lock, one can move aside a lock another has
  just taken while a third creates a fresh one, and two processes can end up
  believing they hold the lock. Only OS-level file locking would close this.
  Running one `collect` per state file at a time (for example from a single
  scheduler) avoids it.
- **Old re-runs.** A re-run of a run created more than
  `--rerun-lookback-hours` before the window start is not seen by the normal
  listing. It is collected only by a `--hours-back` backfill that covers the
  run's creation date.
- **Pre-attribution data.** Events collected before attempt attribution carry
  the run's latest attempt for every artifact of a partially re-run run.
  Explicitly re-collecting such a run (a `--hours-back` backfill over it)
  stores its carried-over results again under the corrected attempt.
- **Unnormalized absolute paths.** `normalizeTestFile` strips only the GitHub
  Actions workspace layouts listed under [Event identity](#event-identity).
  An emitter that writes absolute paths from any other layout (a custom
  checkout path, a different CI) gets a different test id per layout.
- **`--hours-back` cannot narrow.** It only widens the window past the
  watermark. To skip a gap deliberately, delete the repo's entry from
  `state.json`; the next collect then starts from `--hours-back` or the
  72-hour default.
- **Declared sizes.** The extraction budget trusts each zip entry's declared
  uncompressed size. A crafted header that understates its size is not caught
  by the budget check.
- **Identity changes have no migration.** Changing how an adapter resolves
  `file` or `title_path` gives existing tests new ids. The affected repo's
  partitions have to be deleted and re-collected, which is bounded by GitHub's
  artifact retention.
