# Suitevitals

> The vital signs of your test suite.

A CLI-first, zero-infrastructure tool that retroactively ingests the CI artifacts
you already upload and tells you which tests are flaky, how badly, and where.
No server, no instrumentation changes — point it at a GitHub repo, and it
normalizes the test-report artifacts into plain files you own.

> **Status:** v1 feature-complete (M1–M5: collect, report, dashboard, compact, prune, doctor). Not yet published to npm.

## Documentation

Architecture and design rationale live in [`docs/architecture/`](docs/architecture/overview.md):
the [locked decisions](docs/architecture/decisions.md), the [event schema](docs/architecture/event-schema.md),
and the [collector pipeline](docs/architecture/collector.md).

## Requirements

- Node.js >= 24

## Development

```bash
npm install
npm run dev -- collect --help   # run the CLI from source
npm test                        # run the test suite
npm run typecheck               # type-check without emitting
npm run check                   # Biome: lint + format + autofix
npm run lint                    # Biome: lint only
npm run format                  # Biome: format only
npm run build                   # compile to dist/
```

## Authentication

Suitevitals talks to GitHub through a single Octokit transport and resolves a
token in this order:

1. `--token <token>`
2. `GITHUB_TOKEN` environment variable
3. `gh auth token` (the GitHub CLI, if installed and authenticated)

If none yields a token, it exits with a message listing all three options.

## Usage

```bash
suitevitals collect --repo <owner/name> [options]
suitevitals collect --repo <owner/a> --repo <owner/b>   # multiple repos
suitevitals collect --config repos.json                 # repos from a config file
```

| Option | Description |
| --- | --- |
| `--repo <owner/name>` | Repository to collect from; repeat the flag for multiple repos. |
| `--config <path>` | JSON file listing repos and per-repo overrides (see below). |
| `--token <token>` | GitHub token; overrides `GITHUB_TOKEN` and the `gh` CLI. |
| `--hours-back <n>` | Backfill window in hours; overrides the stored watermark. |
| `--state-file <path>` | Path to the state file (default `state.json`). |
| `--data-dir <path>` | Directory for the NDJSON event partitions (default `data`). |
| `--concurrency <n>` | Number of runs to fetch in parallel (default 5). |
| `--workflow <glob>` | Only collect runs of workflows matching this glob (`*` wildcard; default all). |
| `--exclude-trigger <list>` | Skip runs fired by these events (comma-separated, e.g. `pull_request`). |
| `--max-runs <n>` | Process at most this many completed runs per repo; the rest resume next run. |
| `--max-artifact-mb <n>` | Size cap when sniffing unnamed artifacts for reports (default 100). |
| `--full-errors` | Store full error messages without redaction or truncation. |
| `--dry-run` | Show what would be fetched without writing any data. |

At least one repo is required, via `--repo` (repeatable), `--config`, or both. On the first
run for a repo, collection defaults to the last 72 hours; afterwards it resumes from the
stored watermark. Re-running is always safe — overlapping windows are de-duplicated.

Collection is guarded against the usual hazards: a `<state-file>.lock` file rejects a second
`collect` on the same state file (a stale lock whose recorded pid is gone is broken
automatically, and Ctrl-C releases the lock on the way out); an artifact that would decompress
past a 500 MB budget is skipped and reported instead of exhausting memory — a report artifact
already bigger than that budget is skipped before it is even downloaded; a corrupt archive or an
unparseable report file costs that one artifact or file, with a warning, never the run; in a
multi-repo invocation a failing repo is reported and the rest still collect; and a corrupt line
in a partition is skipped with a warning rather than failing the run. Error messages are
redacted by default — known token shapes (GitHub, Slack, AWS, GitLab, npm, OpenAI-style),
`user:pass@` URL credentials, JWTs, PEM private-key blocks, and query-string values — and
truncated to a budget that holds even for single-line dumps; `--full-errors` bypasses both.

### Config file

A `--config` file collects several repos in one invocation. Each repo is a bare `owner/name`
or an object with per-repo overrides; the top-level `hoursBack`/`concurrency` are defaults
applied to every repo:

```json
{
  "hoursBack": 72,
  "concurrency": 5,
  "excludeTriggers": ["pull_request"],
  "repos": [
    "owner/web-app",
    { "repo": "owner/api", "hoursBack": 168, "concurrency": 2, "workflow": "e2e-*" }
  ]
}
```

Settings resolve most-specific-wins: a per-repo value beats the matching CLI flag
(`--hours-back`/`--concurrency`/`--workflow`/`--exclude-trigger`), which beats the config-level
default, which beats the built-in. A repo named on both the CLI and in the config is collected
once. Repos share one state file and data directory; state is keyed per repo, so each has its
own independent watermark. Filtered-out runs are policy skips: the watermark may pass them, so
excluding a noisy workflow never stalls collection. `--exclude-trigger pull_request` is also
the lever that keeps fork-PR-uploaded artifacts out of your data entirely.

## Reporting

Once events are collected, rank a repo's tests by flakiness:

```bash
suitevitals report --repo <owner/name> [options]
```

| Option | Description |
| --- | --- |
| `--repo <owner/name>` | Repository to report on (required; one repo per run). |
| `--data-dir <path>` | Directory holding the NDJSON partitions (default `data`). |
| `--by-matrix` | Rank each (test, matrix cell) separately instead of collapsing cells. |
| `--min-runs <n>` | Minimum runs for a test to be ranked (default 5). |
| `--since <Nd\|ISO>` | Only include runs in the window (e.g. `30d`, `12h`, or a timestamp). |
| `--branch <name>` | Only include runs on this branch (exact match, e.g. `main`). |
| `--workflow <glob>` | Only include runs of workflows matching this glob (`*` wildcard). |
| `--limit <n>` | Show at most this many ranked tests (default 20). |
| `--all` | Also show tests below the min-runs threshold. |
| `--json` | Emit JSON instead of the table. |

```
Flaky tests · owner/repo · 3 tests

 SCORE  TEST                                            RUNS  RETRY%  INTERMIT  MODES
    50  webTables.spec.js › should delete a record          8    100%       0/8      2
     0  login.spec.js › remembers the session               8      0%       0/8      0

1 test(s) below the min-runs threshold hidden (--all to show).
```

The **score** (0–100) treats flakiness as *inconsistency*: it blends pass-after-retry rate,
same-commit intermittence, failure-mode diversity, and workflow re-runs. A test that always
passes — or always fails the same way (broken, not flaky) — scores near zero. The columns show
the signals behind the score so the ranking is explainable, not a magic number. Scores are
colored by severity on an interactive terminal; piped output is plain, and `NO_COLOR` is honored.

### Dashboard

Generate a self-contained HTML dashboard — a dark "vital signs" monitor, one row per test
ranked by flake score, each with a heartbeat sparkline of its recent run outcomes:

```bash
suitevitals dashboard --repo <owner/name> [-o out.html] [--by-matrix] [--min-runs <n>] [--since <Nd|ISO>]
```

| Option | Description |
| --- | --- |
| `--repo <owner/name>` | Repository to report on (required; one repo per run). |
| `-o, --output <path>` | Output HTML file (default `<owner>__<repo>.html`). |
| `--data-dir <path>` | Directory holding the NDJSON partitions (default `data`). |
| `--by-matrix` | Rank each (test, matrix cell) separately instead of collapsing cells. |
| `--min-runs <n>` | Minimum runs for a test to be ranked (default 5). |
| `--since <Nd\|ISO>` | Only include runs in the window (e.g. `30d`). |
| `--branch <name>` | Only include runs on this branch (exact match, e.g. `main`). |
| `--workflow <glob>` | Only include runs of workflows matching this glob (`*` wildcard). |

The output is a single HTML file with inline CSS and no runtime dependencies — open it, screenshot
it, commit it, or host it anywhere.

### Compact

Closed months never change, so they can be compressed to reclaim disk (roughly 10× on JSON; the
current month stays uncompressed for cheap appends):

```bash
suitevitals compact [--repo <owner/name>] [--data-dir <path>]
```

With no `--repo`, every repo in the data directory is compacted. Each closed month's
`<YYYY-MM>.ndjson` becomes `<YYYY-MM>.ndjson.zst`; `report` and `dashboard` read either form
transparently, so compaction is invisible to the rest of the tool. It is idempotent — re-running
compacts only what is new — and crash-safe: if a month is left in both forms (a crash
mid-compaction, or a late backfill into a compacted month), the next run merges them into one
`.zst`, de-duplicating any overlap so nothing ever double-counts.

### Prune

History grows month by month; `prune` applies a retention window by deleting partition files
older than it:

```bash
suitevitals prune --keep-months <n> [--repo <owner/name>] [--data-dir <path>] [--dry-run]
```

`--keep-months` counts the current month, so `--keep-months 12` keeps a rolling year and the
open month always survives. With no `--repo`, every repo in the data directory is pruned;
`--dry-run` lists what would be deleted without touching anything. Pruned months disappear from
reports immediately; if the underlying artifacts still exist on GitHub, a later `--hours-back`
backfill re-collects them (the dedup keys were deleted with the files).

### Doctor

Not sure a repo is set up for collection? `doctor` inspects its recent runs and tells you whether
it uploads parseable test reports — and if not, prints the exact reporter + `upload-artifact` fix
for the detected framework:

```bash
suitevitals doctor --repo <owner/name>
```

It detects the framework from the repo's manifests (Playwright, Cypress, Vitest, Jest, Mocha, or
Java/JUnit) — including monorepos: one tree listing finds `package.json` files in shallow
subdirectories and Java build files at any depth — and either confirms collection will work or
hands you copy-pasteable YAML to make it work. This is the zero-to-collecting onboarding path.

> **Status (v1 feature-complete, M1–M5):** `collect` ingests **JUnit**, **Playwright blob**, and
> **mochawesome** reports from one or more repos (repeatable `--repo` or a `--config` file) into
> dedup'd monthly NDJSON partitions, in parallel with rate-limit backoff, with workflow/trigger
> filters and a `--max-runs` cap, and falls back to sniffing unnamed artifacts (under
> `--max-artifact-mb`) when a run has no name match. `report` streams those partitions back,
> aggregates per-test flake signals, scores them, and prints a ranked terminal table (or JSON),
> filterable by `--since`/`--branch`/`--workflow`; `dashboard` renders the same ranking as a
> self-contained HTML monitor; `compact` zstd-compresses closed months; `prune` applies a
> retention window; `doctor` diagnoses a repo's report setup, monorepos included.

## License

MIT © Adrian Jiga
