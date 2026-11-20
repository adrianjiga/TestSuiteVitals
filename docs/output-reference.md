# Output Reference

What suitevitals writes to disk and prints. The excerpts below come from the
real renderers fed with sample data; names, ids and counts are illustrative.

| Output                     | Written by                              | Where                                        |
| -------------------------- | --------------------------------------- | -------------------------------------------- |
| `<YYYY-MM>.ndjson`         | `collect`                               | `<data-dir>/<owner>__<repo>/`                |
| `<YYYY-MM>.ndjson.zst`     | `compact`                               | `<data-dir>/<owner>__<repo>/`                |
| `state.json`               | `collect`                               | `--state-file`, default `./state.json`       |
| `state.json.lock`, `.lock` | `collect`, `compact`, `prune`           | Next to the state file; `<data-dir>/.lock`   |
| `<owner>__<repo>.html`     | `dashboard`                             | `--output`, default in the working directory |
| Ranked table or JSON       | `report`                                | stdout                                       |
| Progress and summary lines | `collect`, `compact`, `prune`, `doctor` | stdout; `collect` progress on stderr         |

## Data directory

```text
data/                          # --data-dir, default ./data
├── .lock                      # only while collect, compact or prune runs
├── acme__shop/
│   ├── 2026-09.ndjson.zst     # closed month, compacted
│   ├── 2026-10.ndjson.zst
│   └── 2026-11.ndjson         # current month, appended to
└── acme__api/
    └── 2026-11.ndjson
```

- One directory per repo, named `<owner>__<repo>`.
- One file per month, chosen by the run's `started_at`, not by when it was
  collected. A backfill of October runs in November lands in `2026-10.ndjson`.
- Months are UTC.
- `compact` turns every month before the current one into `.ndjson.zst`
  (zstd). Readers accept either form, and a month that has both is read with
  duplicates removed.
- Inside a repo directory, files not named `<YYYY-MM>.ndjson` or
  `<YYYY-MM>.ndjson.zst` are ignored. At the top level, `compact` and `prune`
  without `--repo` treat every directory whose name contains `__` as a repo.

The files are plain text (or zstd of plain text) and diff cleanly, so the data
directory can be committed to git.

## The event record

Each line of a partition is one JSON object: one test, in one run attempt, in
one matrix cell. Lines are compact JSON; shown here pretty-printed.

```json
{
  "schema_version": 1,
  "id": "2c3550d2dfd0adc1",
  "file": "tests/checkout.spec.ts",
  "title_path": ["Checkout", "applies a discount code"],
  "framework": "playwright",
  "source": "artifact",
  "status": "passed",
  "flaky": true,
  "duration_ms": 2310,
  "attempts": [
    {
      "n": 1,
      "status": "failed",
      "duration_ms": 2100,
      "error": {
        "message": "Timed out 5000ms waiting for expect(locator).toBeVisible()",
        "fingerprint": "e81b2d4c90af"
      }
    },
    { "n": 2, "status": "passed", "duration_ms": 2310 }
  ],
  "run": {
    "provider": "github",
    "repo": "acme/shop",
    "run_id": 9981234567,
    "run_attempt": 1,
    "workflow": "Playwright Tests",
    "branch": "main",
    "sha": "f3a91c2d8e0b47a6c1d9e2f3a4b5c6d7e8f90a1b",
    "trigger": "schedule",
    "started_at": "2026-11-16T07:00:09Z"
  },
  "matrix": { "project": "firefox" },
  "collected_at": "2026-11-17T09:12:00.000Z"
}
```

| Field               | Type           | Meaning                                                                                                                                   |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`    | number         | Record format version, currently `1`                                                                                                      |
| `id`                | string         | Test identity: first 16 hex characters of SHA-256 over `file` and `title_path`. The same test in every cell and run shares it             |
| `file`              | string         | Test file, `/`-separated, with the GitHub Actions workspace prefix removed                                                                |
| `title_path`        | string[]       | Suites, outermost first, then the test title                                                                                              |
| `framework`         | string         | Adapter that parsed the report: `junit`, `playwright` or `mochawesome`                                                                    |
| `source`            | string         | Always `artifact`                                                                                                                         |
| `status`            | string         | `passed`, `failed` or `skipped`: the last attempt's status                                                                                |
| `flaky`             | boolean        | The last attempt passed after an earlier attempt failed                                                                                   |
| `duration_ms`       | number         | As reported by the framework                                                                                                              |
| `attempts[]`        | object[]       | One per execution: one per retry for Playwright and for JUnit with Surefire retries, else one                                             |
| `attempts[].n`      | number         | 1-based                                                                                                                                   |
| `attempts[].error`  | object         | Present on failed attempts                                                                                                                |
| `error.message`     | string         | Redacted and cut to 400 characters (first line only when longer), ending `…[truncated]`. Stored whole with `--full-errors`                |
| `error.fingerprint` | string         | 12 hex characters identifying the failure by its stack shape. The same failure at different lines or paths shares it                      |
| `run.provider`      | string         | Always `github`                                                                                                                           |
| `run.repo`          | string         | `owner/name`                                                                                                                              |
| `run.run_id`        | number         | GitHub workflow run id                                                                                                                    |
| `run.run_attempt`   | number         | The run attempt that uploaded the artifact. After a partial re-run, carried-over artifacts keep their original attempt                    |
| `run.workflow`      | string         | Workflow display name                                                                                                                     |
| `run.branch`        | string or null | Head branch                                                                                                                               |
| `run.sha`           | string         | Head commit                                                                                                                               |
| `run.trigger`       | string         | GitHub event that started the run                                                                                                         |
| `run.started_at`    | string         | ISO 8601 creation time of the run; selects the month file                                                                                 |
| `matrix`            | object         | The cell. Playwright: `{ "project": "<name>" }`. Others: the groups of `--matrix-from-artifact`, else `{ "artifact": "<artifact name>" }` |
| `collected_at`      | string         | ISO 8601 time of the `collect` that wrote it                                                                                              |

Redaction replaces GitHub, Slack, AWS, GitLab, npm, Stripe, Google and
OpenAI-style tokens, JWTs, PEM private-key blocks, `Bearer`/`Basic` headers,
`user:pass@` in URLs, values of secret-named keys and flags (`password=`,
`--token …`), and query-string values with `[REDACTED]`.

### Dedup key

`(run.run_id, run.run_attempt, id, matrix)`. `collect` never appends a record
whose key is already in that month's file (plain or compacted), so repeating a
collect writes nothing new. The key includes `matrix`: changing
`--matrix-from-artifact` and re-collecting runs already stored stores them
again under the new cells.

## state.json

```json
{
  "schema_version": 1,
  "repos": {
    "acme/shop": {
      "watermark": "2026-11-17T08:12:44Z",
      "pending_runs": [9981301122],
      "rerun_attempts": { "9979012345": 2 },
      "last_collected_at": "2026-11-17T09:12:00.000Z"
    }
  }
}
```

| Field               | Meaning                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `schema_version`    | Currently `1`                                                                                              |
| `repos`             | One entry per collected repo, keyed by `owner/name`                                                        |
| `watermark`         | The next collect lists runs created at or after this time. Held before the oldest pending run              |
| `pending_runs`      | Runs that were queued or in progress; fetched by id on the next collect until they complete or are deleted |
| `rerun_attempts`    | Run id → highest attempt collected, for re-runs inside the lookback window; only attempts above 1          |
| `last_collected_at` | When this repo was last collected                                                                          |

The file is rewritten after each repo, through a temporary `state.json.tmp`
and a rename, so it is never left half-written. Deleting a repo's entry makes
its next collect behave like a first run.

### Lock files

| File                | Held by                                         | Contents                   |
| ------------------- | ----------------------------------------------- | -------------------------- |
| `<state-file>.lock` | `collect` (including `--dry-run`)               | Holder's pid, random token |
| `<data-dir>/.lock`  | `collect` (not `--dry-run`), `compact`, `prune` | Holder's pid, random token |

Each is created exclusively and removed when the command ends, on error, or on
Ctrl-C. A lock whose pid is no longer running is removed automatically with
`Breaking stale lock <path>: holder <pid> is gone.`

## report

### Terminal table

```text
Flaky tests · acme/shop · 4 tests (last 30d)

 SCORE  TEST                                            RUNS  RETRY%  INTERMIT  MODES
    38  tests/checkout.spec.ts › Checkout › applies a…     40     38%      9/31      3
     4  tests/e2e/webTables.spec.js › Web Tables › sh…     40     10%      2/31      1
     0  tests/login.spec.ts › Login › rejects a bad p…     40      0%      0/31      0

1 test(s) below the min-runs threshold hidden (--all to show).
```

The heading shows the repo, the number of tests scored, and the active
`--since`, `--branch` and `--workflow` filters in parentheses.

| Column     | Meaning                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `SCORE`    | Flake score, 0–100. Rows are sorted by it, then by `RUNS`                                                |
| `TEST`     | `file › suite › test`, cut to 46 characters. With `--by-matrix`, the cell is appended as `[key=value,…]` |
| `RUNS`     | Runs that passed or failed (skips excluded): the evidence behind the score                               |
| `RETRY%`   | Share of those runs that passed only after a failed retry                                                |
| `INTERMIT` | Commits (per matrix cell) that both passed and failed / commits seen                                     |
| `MODES`    | Distinct failure fingerprints. More than one means the test fails in different ways                      |

At most `--limit` (default 20) rows are shown. Tests with fewer than
`--min-runs` runs are summarized in the last line, or listed under
`Below the min-runs threshold (n):` with `--all`. With no eligible tests the
table is replaced by `No flaky tests above the min-runs threshold.`

On a terminal, scores and non-zero signals are coloured; `NO_COLOR` turns this
off.

### `--json`

An array of every scored test, eligible tests first (each group sorted by
score), ignoring `--limit` and `--all`:

```json
[
  {
    "id": "5d0c6b1f2e9a4c77",
    "file": "tests/checkout.spec.ts",
    "title_path": ["Checkout", "applies a discount code"],
    "framework": "playwright",
    "score": 38,
    "raw_score": 42,
    "confidence": 0.8888888888888888,
    "eligible": true,
    "eligible_runs": 40,
    "signals": {
      "retryFlakeRate": 0.375,
      "flipRate": 0.45,
      "intermittenceRate": 0.2903225806451613,
      "diversity": 0.6666666666666666
    },
    "totals": {
      "runs": 40,
      "passed": 37,
      "failed": 3,
      "skipped": 0,
      "flaky_runs": 15
    },
    "first_seen": "2026-10-18T07:00:14Z",
    "last_seen": "2026-11-16T07:00:09Z"
  }
]
```

| Field                     | Meaning                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `matrix`                  | Present only with `--by-matrix`                                                                                |
| `score`                   | `raw_score` × `confidence`, rounded; what the table shows and ranks by                                         |
| `raw_score`               | The signal blend, 0–100, before the small-sample discount                                                      |
| `confidence`              | `n / (n + 5)`, `n` = passed + failed runs weighted by age with `--half-life` (0018, 0019)                      |
| `eligible`                | `eligible_runs >= --min-runs`                                                                                  |
| `signals`                 | The four 0–1 inputs to the score; weights are in [API-Interface-Design.md](API-Interface-Design.md#flakescore) |
| `totals.runs`             | All events for the test in the window, skips included                                                          |
| `first_seen`, `last_seen` | Earliest and latest `run.started_at`                                                                           |

When the filters match no events, `--json` prints `[]`.

## Dashboard HTML

`dashboard` writes `<owner>__<repo>.html` (or `--output`) and prints
`Wrote dashboard for <repo> to <file> (<n> tests).`

The page is one file with inline CSS, no scripts and no external requests, so
it can be opened locally, attached to a CI run or published as-is. It is a dark
"vital signs" monitor:

- **Header:** the repo, the number of tests, how many score 20 or more
  ("flaky"), the generation time and any filters, and a legend.
- **One row per eligible test**, sorted like `report`: the score; the test name
  first, with file and suites dimmed after it (the full path on hover); a
  sparkline of up to the 24 most recent runs, oldest to newest; then retry %,
  intermittent/seen commits and failure modes.
- **Sparkline bars** by outcome: short green for a pass, taller amber for a
  pass after retry, tallest red for a failure, short grey for a skip.
- **Status label** by score: `healthy` (0), `watch` (1–19), `unstable`
  (20–49), `flaky` (50+).
- **Below the min-runs threshold:** a dimmed section listing the rest, labelled
  `low data`.

All text from reports is HTML-escaped.

## collect output

```text
Authenticated with GitHub (token source: gh-cli).

[acme/shop] Listing runs since 2026-11-14T09:12:00.000Z (default).
  First run: defaulting to the last 72h. Use --hours-back to go wider.
  Found 14 run(s): 13 completed, 1 pending
  Fetching artifacts: 13/13 run(s)…
  Artifacts: scanned 13 run(s), saw 39 artifact(s).
    Downloaded 13 report artifact(s), extracted 52 file(s).
    26 non-report artifact(s) skipped.
  Reports: parsed 13/13 candidate file(s).
    2847 test event(s): 2790 passed, 9 failed, 48 skipped.
  Stored: wrote 2847 new event(s), 0 duplicate(s) skipped across 1 partition(s).
    Watermark advanced to 2026-11-17T08:12:44Z.
```

`Listing runs since` ends with where the window start came from: `watermark`,
`hours-back` or `default` (first run). Other lines appear only when they apply:

| Line                                                                                 | Meaning                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `Collecting <n> repositories.`                                                       | More than one repo in this run                                                  |
| `Found <n> re-run(s) of older run(s) to collect.`                                    | Runs before the window that were re-run within `--rerun-lookback-hours`         |
| `Re-checking <n> tracked pending run(s) by id.`                                      | Pending runs from earlier collects, fetched by id                               |
| `…, <n> excluded by filters`                                                         | Runs dropped by `--workflow` or `--exclude-trigger`                             |
| `--max-runs: processing the oldest <n> completed run(s); <m> deferred …`             | The rest are collected next time                                                |
| `sniffed <n> unnamed artifact(s) for reports (tier 3).`                              | Runs with no report-named artifact had their other artifacts checked            |
| `<n> artifact(s) from already-collected attempts skipped (not downloaded).`          | Re-run artifacts already stored                                                 |
| `<n> artifact(s) skipped by --exclude-artifact (not downloaded).`                    |                                                                                 |
| `<n> expired artifact(s) across <m> run(s) (retention elapsed).`                     | GitHub deleted them; they cannot be collected                                   |
| `<n> artifact(s) skipped as oversized (--max-artifact-mb or the extraction budget).` | See [troubleshooting.md](troubleshooting.md#artifacts-are-skipped-as-oversized) |
| `<n> artifact(s) failed to extract and were skipped.`                                | Corrupt archive; a warning names it                                             |
| `<n> candidate file(s) failed to parse and were skipped.`                            | A warning names each file                                                       |
| `Pending run <id> no longer exists; dropping it.`                                    | A tracked run was deleted                                                       |
| `[owner/name] collect failed: <message>`                                             | That repo is retried next collect; the exit code is 1                           |

With `--dry-run`, the artifact lines say `Would download` and `would sniff`,
and nothing after them is printed for the repo. A multi-repo run ends with:

```text
Done: 3 repositories, wrote 4120 new event(s), 12 duplicate(s) skipped.
```

(`Done (dry run): scanned 3 repositories.` with `--dry-run`), followed by
`<n> repositories failed and will be retried next collect.` if any failed.

## compact and prune output

```text
  acme/shop 2026-09: 4.2 MB → 312.5 KB (93% smaller)
  acme/shop 2026-10: 5.1 MB → 380.0 KB (93% smaller)
Compacted 2 month(s): 9.3 MB → 692.5 KB (93% smaller).
```

```text
  acme/shop 2026-05: Deleted 2026-05.ndjson.zst (290.1 KB).
Deleted 1 partition file(s) older than 2026-06, freeing 290.1 KB.
```

`prune --dry-run` prints `Would delete` instead. When there is nothing to do
they print `Nothing to compact — all closed months are already compressed.` or
`Nothing to prune — no partitions older than <month>.`

## doctor output

```text
Authenticated with GitHub (token source: env).
Inspecting acme/shop…
  Framework: playwright
  Artifacts seen: 2

✓ acme/shop uploads parseable reports: blob-report-1, blob-report-2.
  Run `suitevitals collect --repo acme/shop` to start collecting.
```

The check is by artifact name: an artifact counts when its name contains
`report`, `result`, `junit`, `blob` or `mochawesome`. When none does, it prints
`⚠ <repo> uploads no parseable test reports.` followed by the steps and the
workflow YAML to add for the detected framework (`playwright`, `cypress`,
`vitest`, `jest`, `mocha` or `java`), or generic JUnit XML advice when the
framework is `unknown`.
