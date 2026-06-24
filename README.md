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
| `--full-errors` | Store full error messages without redaction or truncation. |
| `--dry-run` | Show what would be fetched without writing any data. |

On the first run for a repo, collection defaults to the last 72 hours; afterwards it
resumes from the stored watermark. Re-running is always safe — overlapping windows are
de-duplicated.

> **Status:** `collect` currently authenticates, lists workflow runs in the window, classifies
> them as completed or pending, downloads + extracts each completed run's report artifacts
> (counting expired ones), and parses JUnit reports into normalized test events. Event storage
> (NDJSON with dedup) is in progress; the Playwright and Mochawesome adapters land in M2.

## License

MIT © Adrian Jiga
