# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev -- <args>          # run the CLI from source via tsx, e.g. `npm run dev -- collect --help`
npm test                       # run the full vitest suite once
npx vitest run test/auth.test.ts   # run a single test file
npx vitest run -t "precedence"     # run tests matching a name
npm run typecheck              # tsc --noEmit (the type gate; CI runs this)
npm run check                  # Biome lint + format + autofix (run before every commit)
npm run build                  # compile src/ to dist/ (publish artifact)
```

CI (`.github/workflows/ci.yml`) runs `biome ci`, `typecheck`, `test`, then `build` on Node 24.

Run `npm run check` before every commit; after a feature, also run tests and update `README.md`
and this file. Formatting is Biome (double quotes, 2-space, 100-col) — let it own style; don't
hand-format.

## Environment

- **Node floor is 24** (`engines`), but local dev commonly runs on Node 22. `npm install` prints an
  EBADENGINE warning — that is expected. Everything dev-facing goes through `tsx`/`vitest`, which run
  on 22, so **do not use Node-24-only runtime APIs**, or you break local dev.
- ESM throughout (`"type": "module"`). Relative imports **must** use `.js` specifiers even from `.ts`
  files (NodeNext resolution) — e.g. `import { resolveToken } from "./auth.js"`.

## Architecture

Suitevitals ingests CI test-report artifacts from GitHub Actions and normalizes them into plain,
git-friendly files, then reports flakiness. It is a CLI with no server and no instrumentation.

- **`src/cli.ts`** — citty entry; registers subcommands. Each command lives in `src/commands/`.
- **`src/github/auth.ts`** — token resolution chain: `--token` → `GITHUB_TOKEN` → `gh auth token` →
  `AuthError`. `resolveToken` takes injectable `env` and `runGhCli` so the chain is unit-tested
  without spawning `gh` or touching `process.env`. Mirror this DI style for anything touching the
  outside world.
- **`src/github/client.ts`** — the *single* Octokit transport, built from a resolved token. Only token
  resolution is pluggable; there is intentionally one transport.

The **M1 walking skeleton is complete**. `collect` is wired end-to-end through:
auth → load state (`src/state/state.ts`) → compute window (`src/collect/window.ts`) → list +
classify runs (`src/github/runs.ts`) → fetch + extract report artifacts (`src/github/artifacts.ts`
for list/match/download, `src/artifacts/extract.ts` for unzip via fflate, `src/artifacts/fetch.ts`
to orchestrate) → parse reports into events (`src/collect/parse.ts` walks files, `src/adapters/`
dispatches by content sniff, `src/events/` holds the schema/identity in `event.ts` and
redaction/fingerprint in `error.ts`) → append to NDJSON (`src/store/` for partition/dedup/append)
and advance the watermark (`src/collect/watermark.ts`). Adapters: **JUnit** (`src/adapters/junit.ts`),
**Playwright blob** (`src/adapters/playwright-blob.ts`, parses `report.jsonl` teleReporter events
— suite tree + per-retry `attempts[]` + matrix from project name), and **Mochawesome**
(`src/adapters/mochawesome.ts`, Cypress/Mocha `stats`+`results` JSON — recursive suite walk, flat
one-attempt-per-test like JUnit, no matrix). All emit the same `ParsedTest` shape + `buildEvent`.

A single `collect` run can target several repos: repeatable `--repo`, a `--config` JSON file, or
both (`src/collect/config.ts` parses/validates and `resolveTargets` merges them most-specific-wins:
per-repo override → CLI flag → config default → built-in, de-duping repos named twice). The repos
share one client/state-file/data-dir and run sequentially via `collectRepo`; state is keyed per
repo and saved after each, so a crash mid-loop keeps the repos already collected. M1 and M2 are
complete; **M3 (report + scoring) is in progress**.

Reporting reads back from the partitions (`src/report/`): `read.ts` streams a repo's events one
line at a time, oldest month first (D3 — never materializes the whole history); `aggregate.ts`
folds them via an incremental `Aggregator` into one `TestAggregate` per test `id` (or per
`(id, matrix)` with `byMatrix`, D5). The aggregate computes the raw flake signals only —
pass/fail/skip, pass-after-retry, retried/rerun runs, sha-keyed intermittence, fingerprint
diversity — with no scoring opinion baked in.

`score.ts` turns an aggregate into a 0–100 flake score. The premise: flaky = *inconsistency*, so
a consistently-failing test (broken, not flaky) scores ~0. It is a weighted blend of normalized
signals — pass-after-retry rate (0.45), same-commit intermittence rate (0.30), failure-mode
diversity beyond the first mode (0.15), workflow re-run rate (0.10) — over `eligibleRuns`
(passed + failed; skips excluded). Samples below `minRuns` (default 5) are scored but flagged
`eligible: false` so the report can set them aside. Remaining M3 slice: the `report` command.

Idempotency contract (D12): `collect` appends durably *first*, then advances the watermark and
saves state — so a crash between is recovered by re-collecting (the `(run_id, run_attempt, id,
matrix)` dedup absorbs the overlap), never skipped. Running `collect` twice yields zero new writes.
The watermark never passes an in-progress run; pending runs are also tracked by id in `pending_runs`.

Adapter design: parsing is a pure `bytes → ParsedTest[]` transform; enrichment (`buildEvent` adds
`id`/`run`, and the matrix — preferring a per-test `matrix` the adapter sets over the collect
default) is separate and shared. Add new formats as adapters, not by touching the pipeline. The
fetch loop takes an `onProgress` callback so `collect` can show live progress on long backfills.
Playwright blob artifacts are double-zipped, so `extractZipNested` recurses one nested level. Pure logic (window, classification, repo parse, state, glob matching,
partitioning, extract, fetch orchestration, redaction, fingerprint, JUnit parse, event build,
dedup, watermark, NDJSON append) is unit-tested; only the raw Octokit calls (`listRunsSince`,
`listRunArtifacts`, `downloadArtifactZip`) are left to integration. Artifact fetching runs up to
`--concurrency` runs in parallel (`p-limit` pool, default 5): each run is processed into an
isolated outcome, then outcomes are folded in input order so the summary and event order stay
deterministic. Rate-limit/transient backoff lives at the transport (`client.ts`) via GitHub's
official `@octokit/plugin-throttling` + `@octokit/plugin-retry` plugins, so it covers every API
call, not just downloads.

Reality check on demo repos: none currently upload JUnit XML except **SeleniumAutomationExample**
(TestNG/Surefire). Playwright uploads blob-report zips (→ Playwright adapter); Cypress uploads
mochawesome JSON (→ Mochawesome adapter). So the JUnit adapter only lights up on Selenium today;
all three demo formats are now covered.

## Locked design decisions

The committed architecture docs live in [`docs/architecture/`](docs/architecture/overview.md)
(overview, decisions D1–D12, event-schema, collector) — start there, and **update them after each
milestone** (part of a milestone's done-criterion). A fuller design doc (`PLAN.md`) is kept
local-only and is not part of this repository; ask the maintainer for it if you need design
context beyond what `docs/` captures. The decisions that constrain code:

- **Data layout:** partitioned NDJSON at `data/<owner>__<repo>/<YYYY-MM>.ndjson`; one record per test
  per run per matrix cell; every record carries `schema_version`.
- **Test identity:** `id = hash(file + title_path)` only. The matrix (browser, viewport, …) is *always
  a dimension, never identity*. Grouping by matrix is a report-time option, so changing it never
  orphans collected data.
- **Idempotency:** dedup key is `(run_id, run_attempt, id, matrix)`. State (the watermark) advances
  **only after** a durable append, and never past an in-progress run. Re-running `collect` must always
  be safe and produce zero duplicates — this is the M1 done-criterion.
- **Errors:** redacted + truncated by default; `error.fingerprint` = hash of normalized stack frames
  (used for failure clustering, independent of the message).

## Conventions

- GitHub Actions are **SHA-pinned** with a `# vX.Y.Z` comment (Dependabot bumps them by reading the
  comment). Keep new actions pinned the same way.
- Use the latest stable versions when adding packages or actions.
