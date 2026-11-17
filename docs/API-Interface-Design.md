# API & Interface Design

This document describes the data shapes passed between stages, the command-line
interface, authentication, the configuration file, and how to add a report
format. [Architecture.md](Architecture.md) explains how the pieces fit
together; [output-reference.md](output-reference.md) shows what each command
writes and prints.

## Core Data Shapes

All shapes live in `src/`. Field names in stored data (events, `state.json`,
`report --json`) are `snake_case`; in-memory report shapes are `camelCase`.

### ParsedTest

What every adapter returns (`src/events/event.ts`): one entry per test in one
report file, before any run or matrix context is attached.

| Field         | Type                     | Notes                                                                                                                        |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `file`        | `string`                 | Test file as the report names it. Normalized later by `buildEvent`                                                           |
| `title_path`  | `string[]`               | Suite names, outermost first, then the test title                                                                            |
| `status`      | `TestStatus`             | `"passed"`, `"failed"` or `"skipped"`: the status of the last attempt                                                        |
| `flaky`       | `boolean`                | `true` only when the last attempt passed and an earlier one failed. Always `false` for one-attempt formats                   |
| `duration_ms` | `number`                 |                                                                                                                              |
| `attempts`    | `TestAttempt[]`          | One per execution: one per retry for Playwright and Surefire JUnit retries, else one                                         |
| `matrix`      | `Record<string, string>` | Optional. Set when the format itself names the cell (Playwright: `{ project }`); otherwise the artifact-name default applies |

`deriveStatus(attempts)` and `deriveFlaky(attempts)` compute `status` and
`flaky` from `attempts`, so adapters stay consistent.

### TestAttempt

| Field         | Type         | Notes                                |
| ------------- | ------------ | ------------------------------------ |
| `n`           | `number`     | 1-based attempt number               |
| `status`      | `TestStatus` |                                      |
| `duration_ms` | `number`     |                                      |
| `error`       | `TestError`  | Optional. Present on failed attempts |

### TestError

Built only through `makeTestError({ message, stack }, options)` in
`src/events/error.ts`.

| Field         | Type     | Notes                                                                                                                                                    |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`     | `string` | Redacted (token shapes, URL credentials, JWTs, PEM keys, secret-named keys, query-string values) and truncated to 400 characters, unless `--full-errors` |
| `fingerprint` | `string` | 12 hex characters: SHA-256 of the stack with paths, line numbers, timestamps and addresses masked. Falls back to the message when there is no stack      |

### RunContext

The workflow run an event came from.

| Field         | Type             | Notes                                                                                      |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `provider`    | `"github"`       |                                                                                            |
| `repo`        | `string`         | `owner/name`                                                                               |
| `run_id`      | `number`         | GitHub's run id                                                                            |
| `run_attempt` | `number`         | The attempt that _uploaded_ the artifact, not necessarily the run's latest attempt         |
| `workflow`    | `string`         | The workflow's display name (`name:` in the YAML), not its file name                       |
| `branch`      | `string \| null` | Head branch; `null` when GitHub reports none                                               |
| `sha`         | `string`         | Head commit                                                                                |
| `trigger`     | `string`         | The event that started the run: `push`, `pull_request`, `schedule`, `workflow_dispatch`, … |
| `started_at`  | `string`         | ISO 8601. The run's creation time; also picks the month partition                          |

### TestEvent

One stored record per test, per run attempt, per matrix cell. It is a
`ParsedTest` plus:

| Field            | Type                     | Notes                                                                   |
| ---------------- | ------------------------ | ----------------------------------------------------------------------- |
| `schema_version` | `number`                 | Currently `1`                                                           |
| `id`             | `string`                 | 16 hex characters: SHA-256 of `file` and `title_path`. Never the matrix |
| `framework`      | `string`                 | `"junit"`, `"playwright"` or `"mochawesome"`                            |
| `source`         | `"artifact"`             |                                                                         |
| `run`            | `RunContext`             |                                                                         |
| `matrix`         | `Record<string, string>` | Always present. The adapter's cell, else the artifact-name cell         |
| `collected_at`   | `string`                 | ISO 8601 time of the `collect` that wrote it                            |

`buildEvent(test, context)` produces it. Before hashing, `file` is normalized:
`\` becomes `/`, and a GitHub Actions workspace prefix (`/home/runner/work/<repo>/<repo>/`,
the macOS and Windows equivalents, self-hosted `…/_work/…` and container
`/__w/…`) is stripped.

The dedup key is `(run.run_id, run.run_attempt, id, matrix)`. See
[output-reference.md](output-reference.md#the-event-record) for a full record.

### State

`state.json` (`src/state/state.ts`):

```ts
interface State {
  schema_version: number; // currently 1
  repos: Record<string, RepoState>; // keyed by "owner/name"
}

interface RepoState {
  watermark?: string; // ISO 8601; collect lists runs created at or after this
  pending_runs: number[]; // queued or in-progress run ids, re-fetched by id next time
  rerun_attempts?: Record<string, number>; // run id → highest attempt already collected
  last_collected_at?: string; // ISO 8601 time of the last successful collect
}
```

A missing file is an empty state. A file that is not valid JSON is an error,
never silently reset.

### TestAggregate

`Aggregator` (`src/report/aggregate.ts`) folds a stream of events into one
row per test `id`, or per `(id, matrix)` with `byMatrix`.

| Field              | Type                     | Notes                                                                                                        |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `id`               | `string`                 |                                                                                                              |
| `file`             | `string`                 | From the first event seen                                                                                    |
| `title_path`       | `string[]`               | From the first event seen                                                                                    |
| `framework`        | `string`                 | From the first event seen                                                                                    |
| `matrix`           | `Record<string, string>` | Only with `byMatrix`                                                                                         |
| `totalRuns`        | `number`                 | Events in the group                                                                                          |
| `passed`           | `number`                 |                                                                                                              |
| `failed`           | `number`                 |                                                                                                              |
| `skipped`          | `number`                 |                                                                                                              |
| `flakyRuns`        | `number`                 | Events with `flaky: true` (passed after a failed retry)                                                      |
| `retriedRuns`      | `number`                 | Events with more than one attempt                                                                            |
| `rerunRuns`        | `number`                 | Events with `run.run_attempt > 1` (a workflow re-run)                                                        |
| `distinctShas`     | `number`                 | Distinct `(sha, matrix cell)` buckets                                                                        |
| `intermittentShas` | `number`                 | Buckets that saw both a pass and a fail                                                                      |
| `fingerprints`     | `number`                 | Distinct error fingerprints across all attempts                                                              |
| `firstSeen`        | `string`                 | Earliest `run.started_at`                                                                                    |
| `lastSeen`         | `string`                 | Latest `run.started_at`                                                                                      |
| `timeline`         | `RunOutcome[]`           | Only with `timeline: true` (the dashboard). `passed`, `flaky`, `failed` or `skipped` per event, oldest first |

Intermittence is always keyed on `(sha, matrix cell)`, even when rows are
collapsed, so a test that passes on Chrome and fails on Firefox at the same
commit does not count as intermittent.

### FlakeScore

`scoreTest(aggregate, { minRuns })` in `src/report/score.ts`.

| Field          | Type           | Notes                                              |
| -------------- | -------------- | -------------------------------------------------- |
| `score`        | `number`       | 0–100, rounded                                     |
| `eligible`     | `boolean`      | `eligibleRuns >= minRuns` (default `minRuns` is 5) |
| `eligibleRuns` | `number`       | `passed + failed`; skips do not count              |
| `signals`      | `FlakeSignals` | The four normalized inputs, each 0–1               |

| Signal              | Weight | Definition                                                                    |
| ------------------- | ------ | ----------------------------------------------------------------------------- |
| `retryFlakeRate`    | 0.45   | `flakyRuns / eligibleRuns`                                                    |
| `intermittenceRate` | 0.30   | `intermittentShas / distinctShas`                                             |
| `diversity`         | 0.15   | `0` for zero or one fingerprint, then `(fingerprints − 1) / 3`, capped at `1` |
| `rerunRate`         | 0.10   | `rerunRuns / eligibleRuns`                                                    |

`score = round(100 × Σ weight × signal)`. A test that always passes, or always
fails the same way, scores close to 0: it is broken, not flaky.

`rankTests(aggregates, { minRuns })` (`src/report/rank.ts`) returns
`{ eligible, belowThreshold }`, each a list of `{ aggregate, score }` sorted by
score, then by `eligibleRuns` (more evidence first), then by `id`.

## Module Exports

None. The package publishes only the `suitevitals` binary (`bin` in
`package.json`, compiled to `dist/cli.js`) and has no `main` or `exports`
entry. The modules under `src/` are internal and may change in any release;
use the CLI, or read the stored NDJSON directly.

## Command-Line Interface

`suitevitals <command> [options]`. With no command it prints usage and exits 1.
`-h, --help` prints usage for the tool or any command. `-v, --version`, given
as the only argument, prints the version.

Flags take a value as `--flag value` or `--flag=value`. Boolean flags take no
value.

### collect

Collect test-report artifacts from GitHub Actions runs and append them as
events. Needs a token (see [Authentication](#authentication)).

| Flag                             | Default         | Meaning                                                                                                               |
| -------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>`            |                 | Repository to collect from. Repeatable                                                                                |
| `--config <path>`                |                 | JSON file listing repos and per-repo overrides (see [Configuration File](#configuration-file))                        |
| `--token <token>`                |                 | GitHub token; overrides `GITHUB_TOKEN` and `gh`                                                                       |
| `--hours-back <hours>`           | 72 on first run | Start the window this many hours ago. Widens past the stored watermark, never narrows it. Positive number             |
| `--state-file <path>`            | `state.json`    | Watermark and pending-run state                                                                                       |
| `--data-dir <path>`              | `data`          | Directory for the NDJSON partitions                                                                                   |
| `--dry-run`                      | `false`         | List runs and artifacts, download and write nothing                                                                   |
| `--full-errors`                  | `false`         | Store error messages without redaction or truncation                                                                  |
| `--concurrency <n>`              | `5`             | Runs fetched in parallel. Positive integer                                                                            |
| `--workflow <glob>`              | all workflows   | Only collect runs whose workflow name matches. `*` is the only wildcard; case-insensitive                             |
| `--exclude-trigger <events>`     |                 | Comma-separated trigger events to skip, e.g. `pull_request`                                                           |
| `--exclude-artifact <globs>`     |                 | Comma-separated artifact-name globs never downloaded, e.g. a merged roll-up report                                    |
| `--matrix-from-artifact <regex>` |                 | Regex whose named groups, matched against each artifact name, become the matrix dimensions                            |
| `--max-artifact-mb <mb>`         | `100`           | Size cap for artifacts downloaded only to sniff for reports (runs with no report-named artifact). Positive number     |
| `--max-runs <n>`                 | no cap          | Process at most this many completed runs per repo, oldest first; the rest wait for the next collect. Positive integer |
| `--rerun-lookback-hours <hours>` | `48`            | Re-list runs created this far back to catch re-runs of older runs. `0` disables                                       |

At least one repo must come from `--repo` or `--config`. The window starts at
the stored watermark; on a repo's first collect it is the last 72 hours unless
`--hours-back` is given.

Notable behavior:

- **Artifact discovery.** Artifacts whose name contains `report`, `result`,
  `junit`, `blob` or `mochawesome` (case-insensitive) are downloaded. If a run
  has none, its other artifacts under `--max-artifact-mb` are downloaded too
  and kept only if a file inside parses as a report. Expired artifacts are
  counted and reported.
- **Size limits.** Each archive may expand to at most 500 MB. A report-named
  artifact whose compressed size is already over that is skipped before
  download. Both cases are reported as oversized.
- **Filters are policy.** Runs dropped by `--workflow` or `--exclude-trigger`
  are never collected, and the watermark may move past them.
- **Flags are checked up front.** An empty `--workflow`, `--exclude-trigger` or
  `--exclude-artifact`, or an invalid `--matrix-from-artifact`, exits 1 before
  the config file is read or any network call is made.
- **Pending runs.** Queued and in-progress runs are not collected. The
  watermark stops before them and their ids are saved, so they are re-fetched
  by id until they complete or are deleted.
- **Re-runs.** A run re-run within `--rerun-lookback-hours` is collected again
  for its new attempt; artifacts from attempts already collected are skipped
  before download.
- **Idempotency.** Events are appended and flushed to disk first; only then
  does the watermark advance. A crash in between is recovered by the next
  collect, and the dedup key keeps re-collected events from being stored twice.
- **Several repos** run one after another with one client, state file and data
  directory. State is saved after each repo. One repo failing is reported and
  the others still run.
- **Locks.** `collect` holds `<state-file>.lock` and, unless `--dry-run`,
  `<data-dir>/.lock`. A second process on the same files fails fast.
- **Progress.** A `Fetching artifacts: n/total run(s)…` line on stderr: one
  rewritten line on a terminal, periodic lines otherwise.
- **Signals.** Ctrl-C or `SIGTERM` releases the locks and exits 130 or 143.

### report

Rank one repo's tests by flake score, from stored events. Makes no network
calls.

| Flag                  | Default | Meaning                                                                                      |
| --------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `--repo <owner/name>` |         | Required. Exactly one                                                                        |
| `--data-dir <path>`   | `data`  | Directory holding the partitions                                                             |
| `--by-matrix`         | `false` | One row per test per matrix cell instead of one per test                                     |
| `--min-runs <n>`      | `5`     | Passed-or-failed runs a test needs to be ranked. Positive integer                            |
| `--since <span\|ISO>` |         | Only runs started within the span (`30d`, `12h`) or at or after the timestamp (`2026-10-01`) |
| `--branch <name>`     |         | Only runs on this branch, exact match                                                        |
| `--workflow <glob>`   |         | Only runs whose workflow name matches. `*` wildcard, case-insensitive                        |
| `--limit <n>`         | `20`    | Ranked rows shown in the table. Positive integer                                             |
| `--all`               | `false` | Also list tests below `--min-runs` instead of a one-line count                               |
| `--json`              | `false` | Print every scored test as JSON instead of the table                                         |

`--limit` and `--all` affect the table only; `--json` always prints every test,
eligible ones first. If the filters exclude every stored event, it prints
`No events for <repo> match <filters>; loosen --since/--branch/--workflow.`
(`[]` with `--json`) and exits 0.

### dashboard

Write one repo's ranking as a self-contained HTML file. Makes no network calls.

| Flag                  | Default                | Meaning                                        |
| --------------------- | ---------------------- | ---------------------------------------------- |
| `--repo <owner/name>` |                        | Required. Exactly one                          |
| `-o, --output <path>` | `<owner>__<repo>.html` | Output file, relative to the working directory |
| `--data-dir <path>`   | `data`                 | Directory holding the partitions               |
| `--by-matrix`         | `false`                | As for `report`                                |
| `--min-runs <n>`      | `5`                    | As for `report`                                |
| `--since <span\|ISO>` |                        | As for `report`                                |
| `--branch <name>`     |                        | As for `report`                                |
| `--workflow <glob>`   |                        | As for `report`                                |

The page lists every test (no `--limit`), with tests below `--min-runs` in a
separate, dimmed section. An existing file at the output path is overwritten.

### compact

Compress closed months with zstd. Each `<YYYY-MM>.ndjson` before the current
UTC month becomes `<YYYY-MM>.ndjson.zst`; the current month stays plain so
appends stay cheap.

| Flag                  | Default    | Meaning                          |
| --------------------- | ---------- | -------------------------------- |
| `--repo <owner/name>` | every repo | Repository to compact            |
| `--data-dir <path>`   | `data`     | Directory holding the partitions |

Safe to repeat. If a month has both forms (a late backfill into a compacted
month, or an interrupted compact), they are merged into one `.zst` with
duplicates removed. Lines that cannot be parsed are kept as they are. Holds
`<data-dir>/.lock`.

### prune

Delete partition files for months older than a retention window.

| Flag                  | Default    | Meaning                                                                    |
| --------------------- | ---------- | -------------------------------------------------------------------------- |
| `--keep-months <n>`   |            | Required. Months to keep, counting the current UTC month. Positive integer |
| `--repo <owner/name>` | every repo | Repository to prune                                                        |
| `--data-dir <path>`   | `data`     | Directory holding the partitions                                           |
| `--dry-run`           | `false`    | List what would be deleted, delete nothing                                 |

`--keep-months 1` keeps only the current month. Both `.ndjson` and
`.ndjson.zst` files are removed; other files in the directory are left alone.
Pruned history disappears from reports immediately. A later `collect` with a
wide enough `--hours-back` re-collects it while GitHub still has the
artifacts. Holds `<data-dir>/.lock`.

### doctor

Check whether a repo uploads test reports `collect` can read, and print the
fix if it does not. Needs a token.

| Flag                  | Default | Meaning                                         |
| --------------------- | ------- | ----------------------------------------------- |
| `--repo <owner/name>` |         | Required                                        |
| `--token <token>`     |         | GitHub token; overrides `GITHUB_TOKEN` and `gh` |

It reads the artifact names of up to 10 completed runs from the last 30 days
and passes when one contains `report`, `result`, `junit`, `blob` or
`mochawesome`; it does not download them. It also detects the framework from
the repo's `package.json` files (up to five, `node_modules` excluded) or a Java
build file (`pom.xml`, `build.gradle`, `build.gradle.kts`). When no artifact
matches, it prints the reporter setup and `actions/upload-artifact` YAML for
that framework: Playwright, Cypress, Vitest, Jest, Mocha, Java, or generic
JUnit XML. It writes nothing.

### Environment variables

| Variable            | Effect                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`      | Token for `collect` and `doctor` when `--token` is not given                                           |
| `SUITEVITALS_DEBUG` | Any non-empty value prints a failing command's full error and stack instead of the one-line `Error: …` |
| `NO_COLOR`          | Disables terminal colour                                                                               |
| `FORCE_COLOR`       | Forces terminal colour when output is not a terminal                                                   |

Colour is only used on a terminal and never in `--json` output.

### Exit Codes

| Command     | `0`                                                                            | `1`                                                                                                            |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `collect`   | Every repo collected, including runs that wrote no new events, and `--dry-run` | No token found; invalid flag or config; no repos given; a lock is held; any repo failed (the others still ran) |
| `report`    | Report printed, including when filters match nothing                           | No stored events for the repo; invalid flag; more than one `--repo`                                            |
| `dashboard` | File written, or filters match nothing                                         | No stored events for the repo; invalid flag; more than one `--repo`; the file cannot be written                |
| `compact`   | Done, including when there is nothing to compact                               | The data directory lock is held; invalid `--repo`; a read or write error                                       |
| `prune`     | Done, including when there is nothing to prune                                 | The data directory lock is held; invalid `--keep-months` or `--repo`                                           |
| `doctor`    | Diagnosis printed, whether or not the repo uploads reports                     | No token found; a GitHub API error (for example a repo the token cannot see)                                   |
| (any)       | `--help`, `--version`                                                          | No command; unknown command; missing required flag (usage is printed)                                          |

`collect` exits 130 after Ctrl-C and 143 after `SIGTERM`, having released its
locks. A failing command prints `Error: <message>` on stderr; set
`SUITEVITALS_DEBUG=1` for the stack. Per-repo failures inside a multi-repo
`collect` are printed as `[owner/name] collect failed: <message>`.

## Authentication

`collect` and `doctor` resolve a token in this order and use the first one
found:

1. `--token <token>`
2. the `GITHUB_TOKEN` environment variable
3. `gh auth token`, when the GitHub CLI is installed and signed in

If none gives a token, the command prints how to provide one and exits 1. The
first line of output names the source used:
`Authenticated with GitHub (token source: flag | env | gh-cli).`

suitevitals only reads from GitHub.

| Token kind             | Needs                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Fine-grained           | **Actions: read** and **Contents: read** on each repo (`doctor` reads file contents)     |
| Classic                | `repo` scope for private repos; no scope for public ones                                 |
| Actions `GITHUB_TOKEN` | `actions: read` and `contents: read` in the workflow's `permissions:`, for the same repo |

Every API call goes through one Octokit client that waits and retries on
primary and secondary rate limits (up to three times, with a warning each
time) and on transient server and network errors.

`report`, `dashboard`, `compact` and `prune` work offline and need no token.

## Configuration File

`collect --config <path>` reads a JSON file listing the repos to collect and
optional settings. Other commands do not read it.

```json
{
  "hoursBack": 720,
  "concurrency": 5,
  "excludeTriggers": ["pull_request"],
  "repos": [
    {
      "repo": "acme/web",
      "excludeArtifacts": ["final-test-report"],
      "matrixFromArtifact": "results-(?<browser>chrome|firefox)-(?<viewport>[^-]+)"
    },
    { "repo": "acme/api", "workflow": "Integration*" },
    "acme/mobile"
  ]
}
```

`repos.example.json` in the repository root is a working example.

### Keys

The top-level keys are defaults for every repo. Each `repos[]` entry is either
`"owner/name"` or an object with `repo` and any of the same keys.

| Key                  | Type       | CLI equivalent           | Meaning                                                    |
| -------------------- | ---------- | ------------------------ | ---------------------------------------------------------- |
| `repos`              | `array`    | `--repo`                 | Required, top level only. Strings or objects               |
| `repo`               | `string`   |                          | Required in an object entry. `owner/name`                  |
| `hoursBack`          | `number`   | `--hours-back`           | Positive number                                            |
| `concurrency`        | `number`   | `--concurrency`          | Positive integer                                           |
| `workflow`           | `string`   | `--workflow`             | Non-empty glob                                             |
| `excludeTriggers`    | `string[]` | `--exclude-trigger`      | Non-empty array of non-empty strings                       |
| `excludeArtifacts`   | `string[]` | `--exclude-artifact`     | Non-empty array of non-empty strings                       |
| `matrixFromArtifact` | `string`   | `--matrix-from-artifact` | Valid regex with at least one named group, checked on load |

The remaining `collect` flags (`--state-file`, `--data-dir`, `--dry-run`,
`--full-errors`, `--max-artifact-mb`, `--max-runs`, `--rerun-lookback-hours`,
`--token`) have no config key and apply to every repo in the run.

Validation is strict: a wrong type, an empty list or a bad regex fails before
any network call, with a message such as
`Invalid config repos.json repos[1] concurrency: expected a positive integer.`
Unknown keys are ignored.

### Precedence

For each repo and each key, the most specific value wins:

1. the key in that repo's `repos[]` entry
2. the CLI flag
3. the top-level key in the config file
4. the built-in default

Repos come from the config file first, in file order, then any `--repo` flags
not already listed. A repo named twice is collected once, with its config
entry.

## Extensibility Guide

### Adding a report format

A format is added as an adapter; the collect pipeline itself does not change.

1. **Write the adapter** in `src/adapters/<framework>.ts`, exporting:
   - `<FRAMEWORK>_FRAMEWORK`, the string stored as `framework` on every event.
   - `looksLike<Framework>(content: string): boolean`, a cheap sniff over the
     first ~2000 characters that keys on a marker near the top of the file and
     rejects the other formats.
   - `parse<Framework>(content: string, options: RedactOptions = {}): ParsedTest[]`,
     a pure transform with no I/O. Build every error with `makeTestError`
     (never by hand), so messages are redacted and fingerprinted. Do not compute
     `id`, run context or a default matrix; `buildEvent` adds those. Set a
     per-test `matrix` only if the format itself names the cell. Set `flaky`
     with `deriveFlaky(attempts)`; for one-attempt formats it is `false`.

   Start from `mochawesome.ts` (recursive suite walk, one attempt per test),
   `junit.ts` (nested suites, Surefire retries as extra attempts) or
   `playwright-blob.ts` (retries as `attempts[]`, matrix from the project name).
2. **Register the sniff** in `detectAndParse` in `src/adapters/dispatch.ts`,
   after the existing branches. Make sure no existing format's sample matches
   your sniff, and yours matches none of theirs.
3. **Check the file extension.** The parse step only reads `.xml`, `.jsonl` and
   `.json` files. Add a new extension to `CANDIDATE_EXTENSIONS` in
   `src/collect/parse.ts`. If the artifact name your framework usually uploads
   contains none of `report`, `result`, `junit`, `blob` or `mochawesome`,
   collection still finds it through the sniff fallback, within
   `--max-artifact-mb`.
4. **Test it** in `test/<framework>.test.ts`, following
   `test/mochawesome.test.ts`: the sniff accepts its own sample and rejects the
   others; suite nesting produces the right `title_path`; every status maps
   correctly; a failure gets a redacted message and a 12-hex fingerprint; the
   `flaky` and `attempts` shape is right.
5. **Document it** in the supported-formats list in `README.md` and in
   [Technical-Design.md](Technical-Design.md).

Run `npm run check`, `npm run typecheck` and `npm test` before committing.

### Changing the event schema

Bump `EVENT_SCHEMA_VERSION` in `src/events/event.ts`, keep readers able to
handle records with the older version (stored history is never rewritten), and
record the change in [decisions/](decisions/). The test identity
(`hash(file + title_path)`) and the dedup key are fixed; changing either splits
or duplicates existing history.
