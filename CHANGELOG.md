# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-17

Initial public release. Requires Node.js 24 or newer.

### Added

- CLI commands: `collect`, `report`, `dashboard`, `doctor`, `compact` and `prune`
- Collection of test-report artifacts from GitHub Actions runs, read-only, with no server and no changes to the tests
- Report adapters for JUnit XML, Playwright blob reports and Mochawesome JSON, chosen by sniffing file content
- Tiered artifact discovery: report-named artifacts first, then other artifacts under `--max-artifact-mb` (default 100) when a run has no name match
- Storage as monthly NDJSON partitions at `data/<owner>__<repo>/<YYYY-MM>.ndjson`, one record per test per run per matrix cell, each with a `schema_version`
- Stable test identity from file and title path; the matrix is a dimension, never part of the identity
- Idempotent collection: a dedup key of `(run_id, run_attempt, id, matrix)`, a watermark that advances only after a durable append and never past an in-progress run
- Tracking of in-progress runs by id, so a run still running at collect time is picked up later
- Re-run handling: runs from the last `--rerun-lookback-hours` (default 48) are re-listed to pick up new attempts
- Matrix cells from artifact names, with `--matrix-from-artifact` to split them into named dimensions
- `--exclude-artifact` to drop roll-up artifacts by name before download
- Collect filters: `--workflow` glob, `--exclude-trigger` events and a `--max-runs` cap for backfills
- Multi-repo collection via repeatable `--repo` and a `--config` JSON file with per-repo overrides
- Parallel fetching (`--concurrency`, default 5) with rate-limit and transient-error backoff on every API call
- Live progress output during long collections, and `--dry-run` to preview without writing
- Flake score from 0 to 100 blending pass-after-retry, same-commit intermittence, failure-mode diversity and workflow re-runs
- `report` as a terminal table or `--json`, with `--since`, `--branch`, `--workflow`, `--by-matrix`, `--min-runs`, `--limit` and `--all`
- `dashboard`: a self-contained HTML file with inline CSS, one row per test and an outcome sparkline
- `doctor`: detects Playwright, Cypress, Vitest, Jest, Mocha and Java projects, monorepos included, and prints the reporter and upload YAML to fix a repo that uploads no reports
- `compact`: zstd compression of closed months, read transparently by every command
- `prune`: retention by `--keep-months`, with `--dry-run`
- Redaction and truncation of stored error messages by default, covering common token shapes, URL credentials, JWTs, PEM private keys, query-string values and secret-named keys; `--full-errors` turns it off
- Error fingerprints from normalized stack frames, for grouping failures by cause
- Zip extraction guarded against path traversal and capped by a 500 MB decompression budget
- Control characters in test titles and artifact names neutralized before they reach the terminal
- Lock files that stop two `collect` runs, or `collect` and `compact`/`prune`, from writing the same data at once
- Token resolution from `--token`, `GITHUB_TOKEN` or `gh auth token`
- Colored terminal output that honours `NO_COLOR` and stays plain when piped

[0.1.0]: https://github.com/adrianjiga/TestSuiteVitals/releases/tag/v0.1.0
