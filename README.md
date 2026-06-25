# Suitevitals

> The vital signs of your test suite.

A CLI-first, zero-infrastructure tool that retroactively ingests the CI artifacts
you already upload and tells you which tests are flaky, how badly, and where.
No server, no instrumentation changes — point it at a GitHub repo, and it
normalizes the test-report artifacts into plain files you own.

> **Status:** early development (M1 — walking skeleton). Not yet published to npm.

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
```

| Option | Description |
| --- | --- |
| `--repo <owner/name>` | Repository to collect from (required). |
| `--token <token>` | GitHub token; overrides `GITHUB_TOKEN` and the `gh` CLI. |
| `--hours-back <n>` | Backfill window in hours; overrides the stored watermark. |
| `--state-file <path>` | Path to the state file (default `state.json`). |
| `--data-dir <path>` | Directory for the NDJSON event partitions (default `data`). |
| `--concurrency <n>` | Number of runs to fetch in parallel (default 5). |
| `--full-errors` | Store full error messages without redaction or truncation. |
| `--dry-run` | Show what would be fetched without writing any data. |

On the first run for a repo, collection defaults to the last 72 hours; afterwards it
resumes from the stored watermark. Re-running is always safe — overlapping windows are
de-duplicated.

> **Status (M2 in progress):** `collect` authenticates, lists workflow runs, downloads +
> extracts report artifacts **in parallel** (`--concurrency`, with live progress and
> transport-level rate-limit backoff), parses **JUnit** and **Playwright blob** reports into
> normalized events — including per-retry `attempts[]` and the matrix dimension — and appends
> them to monthly NDJSON partitions with dedup (running it twice produces zero duplicates).
> Next: Mochawesome adapter and multi-repo config.

## License

MIT © Adrian Jiga
