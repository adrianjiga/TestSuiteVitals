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
npm run build                  # clean dist/ and compile src/ to it (prepublishOnly runs tests + build)
```

CI (`.github/workflows/ci.yml`) runs `npm audit` (prod deps, high+), `biome ci`, `typecheck`,
`test`, then `build` on Node 24, with a read-only `GITHUB_TOKEN`.

Run `npm run check` before every commit; after a feature, also run tests and update `README.md`
and this file. Formatting is Biome (double quotes, 2-space, 100-col) — let it own style; don't
hand-format.

## Environment

- **Node 24 everywhere** — `engines`, CI and local dev — so Node 24 runtime APIs are fine. The
  maintainer's nvm *default* alias is still 22.19, so a non-interactive shell can resolve Node 22;
  put Node 24 first on `PATH` (e.g. `nvm use 24`) before running the gates.
- ESM throughout (`"type": "module"`). Relative imports **must** use `.js` specifiers even from `.ts`
  files (NodeNext resolution) — e.g. `import { resolveToken } from "./auth.js"`.

## Architecture

Suitevitals ingests CI test-report artifacts from GitHub Actions and normalizes them into plain,
git-friendly files, then reports flakiness. It is a CLI with no server and no instrumentation.

- **`src/cli.ts`** — citty entry; registers subcommands (each wrapped by `withCleanErrors`, so a
  thrown error prints one `Error: …` line and exits 1; `SUITEVITALS_DEBUG=1` prints the stack).
  Each command lives in `src/commands/`.
- **`src/github/auth.ts`** — token resolution chain: `--token` → `GITHUB_TOKEN` → `gh auth token` →
  `AuthError`. `resolveToken` takes injectable `env` and `runGhCli` so the chain is unit-tested
  without spawning `gh` or touching `process.env`. Mirror this DI style for anything touching the
  outside world.
- **`src/github/client.ts`** — the *single* Octokit transport, built from a resolved token. Only token
  resolution is pluggable; there is intentionally one transport.

The **M1 walking skeleton is complete**. `collect` is wired end-to-end through:
auth → load state (`src/state/state.ts`) → compute window (`src/collect/window.ts`) → list runs +
re-fetch tracked pending ids (`src/github/runs.ts`) → filter by policy + cap (`src/collect/filter.ts`)
→ classify → fetch + extract report artifacts (`src/github/artifacts.ts`
for list/match/download, `src/artifacts/extract.ts` for unzip via fflate — zip-slip-guarded and
capped by a declared-size decompression budget so zip bombs are skipped before inflating; a
report artifact whose compressed size already exceeds that budget is skipped before download,
and any other extraction or parse failure costs only that artifact/file with a warning,
`src/artifacts/fetch.ts` to orchestrate) → parse reports into events (`src/collect/parse.ts` walks files, `src/adapters/`
dispatches by content sniff, `src/events/` holds the schema/identity in `event.ts` and
redaction/fingerprint in `error.ts`) → append to NDJSON (`src/store/` for partition/dedup/append)
and advance the watermark (`src/collect/watermark.ts`). Adapters: **JUnit** (`src/adapters/junit.ts`,
one attempt per test unless Surefire recorded retries via `flakyFailure`/`rerunFailure` elements),
**Playwright blob** (`src/adapters/playwright-blob.ts`, parses `report.jsonl` teleReporter events
— suite tree + per-retry `attempts[]` + matrix from project name), and **Mochawesome**
(`src/adapters/mochawesome.ts`, Cypress/Mocha `stats`+`results` JSON — recursive suite walk, flat
one-attempt-per-test, no matrix). All emit the same `ParsedTest` shape + `buildEvent`.

A single `collect` run can target several repos: repeatable `--repo`, a `--config` JSON file, or
both (`src/collect/config.ts` parses/validates and `resolveTargets` merges them most-specific-wins:
per-repo override → CLI flag → config default → built-in, de-duping repos named twice — the
overridable fields are `hoursBack`, `concurrency`, `workflow`, and `excludeTriggers`). Collect-time
filters (`src/collect/filter.ts`: `--workflow` glob, `--exclude-trigger` events) drop runs by
*policy* — the watermark may pass excluded runs, unlike pending ones, so filtering a busy workflow
never stalls collection; `--exclude-trigger pull_request` is also the lever that keeps fork-PR
artifacts out. A GitHub re-run keeps its run's `created_at`, so listing reaches
`--rerun-lookback-hours` (default 168) behind the window and `src/collect/rerun.ts` keeps a run
from that stretch only when its attempt beats `rerun_attempts` in state; each artifact's events
carry the attempt that uploaded it (`attemptForArtifact`), since partial re-runs carry earlier
attempts' artifacts over. Run listing splits `created` ranges past GitHub's 1000-result cap
(`listRunsWindowed`). `--max-runs` caps a backfill oldest-first (`capRuns`/`watermarkDisposal`), and the
watermark never passes a deferred run. The repos share one client/state-file/data-dir and run
sequentially via `collectRepo`; state is keyed per repo and saved after each, so a crash mid-loop
keeps the repos already collected, and one repo's failure is reported (non-zero exit) while the
rest still collect.

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
`eligible: false` so the report can set them aside.

The `report` command (`src/commands/report.ts`) wires it together: stream → aggregate → `rankTests`
(`rank.ts`, splits eligible/below-threshold, sorts by score then evidence) → `render.ts` (terminal
table or `--json`). Flags: `--by-matrix`, `--min-runs`, `--since <Nd|ISO>`, `--branch` (exact),
`--workflow` (glob, shared `matchesGlob`), `--limit`, `--all`. `dashboard` takes the same
event filters.

The `dashboard` command (`src/commands/dashboard.ts`) renders the same `read → aggregate → rank`
pipeline as a self-contained HTML file (`src/report/dashboard.ts` — inline CSS, zero runtime deps):
a dark "vital signs" monitor, one row per test with a heartbeat sparkline. The sparkline needs a
per-test time-ordered outcome list, so the `Aggregator` takes an opt-in `timeline` flag (off for
`report`, so it pays no memory cost) that records a `RunOutcome[]` sorted by run start.

The `compact` command (`src/commands/compact.ts` → `src/store/compact.ts`) zstd-compresses closed
months (D2): each `<YYYY-MM>.ndjson` becomes `<YYYY-MM>.ndjson.zst`, the current month stays
uncompressed for cheap appends. The compression chokepoint is `src/store/compress.ts`
(built-in `node:zlib` zstd — no native dependency, so installs never
need an install script or a compiler, and it reads files written by the old `@mongodb-js/zstd`). The
reader (`read.ts`) and append-dedup (`ndjson.ts`) read either form transparently. Crash safety:
compact writes and fsyncs the new `.zst` as a temp file, atomically renames it (fsyncing the
directory, `src/store/durable.ts`), then removes the raw
`.ndjson`; if both forms coexist for a month (a crash window, or a late backfill into a compacted
month) the reader dedups by key per month so nothing double-counts, and a later `compact` merges
them back into one `.zst`, deduping by key during the merge — the reader's both-forms dedup only
holds while two files coexist, so the merge must bake in no duplicates. A partition line that
cannot be parsed is warn-and-skipped by the reader and the append-dedup, and kept verbatim by
compact (it deletes its sources, so it never drops what it cannot parse). The `prune` command
(`src/commands/prune.ts` → `src/store/prune.ts`) is retention: it deletes partition files for
months older than `--keep-months` (counting the current month, which always survives);
`--dry-run` previews, and a later backfill over a pruned window re-collects it.

The `doctor` command (`src/commands/doctor.ts`) is the onboarding path: it inspects a repo's
recent runs for report-looking artifacts and, if none, prints the exact reporter + `upload-artifact`
YAML fix for the detected framework. The diagnosis is pure (`src/doctor/diagnose.ts`: `detectFramework`
unions `package.json` deps across manifests / spots a Java build file, then a `FRAMEWORK → fix`
table) over signals gathered by the command via the GitHub API (`src/github/contents.ts`,
integration): one git-trees listing finds monorepo `package.json` files (shallow, capped 5,
`node_modules` excluded — `packageJsonPaths`) and Java build files at any depth, falling back to
root-only contents probes for huge/empty repos.

Tier-3 artifact discovery (D9) lives in `fetchRun` (`src/artifacts/fetch.ts`): when a run has *no*
report-name match, its remaining artifacts under `--max-artifact-mb` (default 100) are downloaded
and extracted too, and the parse step's content sniff keeps only the real reports — so a report
uploaded under an unexpected name is still collected. Oversized sniff candidates are counted and
surfaced, never silently dropped. The whole v1 plan (**M1–M5**) is now feature-complete.

Because `doctor` probes for maybe-absent files (`pom.xml`, …), `createGitHubClient` installs a
`quietLog` that drops the bundled request-log plugin's automatic `… - 404 with id …` line (the
error still throws and is handled); real rate-limit warnings are untouched.

Terminal color lives in `src/colors.ts`: a semantic `Palette` (heading/repo/dim/good/warn/bad/
score/signal) built over picocolors. `createPalette(enabled)` returns a no-op palette when
disabled, so rendering stays pure — `renderReport` and the `collect` print helpers take an
injected palette and default to plain (tests assert on colorless output). Commands enable color
via `colorSupported` (picocolors' TTY / `NO_COLOR` / `FORCE_COLOR` detection). `--json` is never
colored. Color is applied *after* column padding so ANSI codes never break table alignment. Artifact-derived
text (test titles, file/artifact names, parser errors) goes through `terminalSafe` before printing,
so an ESC smuggled into a report cannot drive the terminal; `--json` and the dashboard escape it
themselves.

Idempotency contract (D12): `collect` appends durably *first* (the append and its directory are fsynced), then
advances the watermark and saves state — so a crash between is recovered by re-collecting (the
`(run_id, run_attempt, id, matrix)` dedup absorbs the overlap), never skipped. Running `collect`
twice yields zero new writes. The watermark never passes an in-progress run; pending runs are also
tracked by id in `pending_runs` and re-fetched by id once the window listing no longer surfaces
them, so a wide `--hours-back` can never strand one. `state.json` is written atomically
(fsynced temp + rename). A `<state-file>.lock` single-writer lock (`src/state/lock.ts`) rejects a
concurrent `collect` on the same state file, so the read-keys → append sequence never races
itself, and a `<data-dir>/.lock` (`acquireDataDirLock`, taken by `collect`, `compact` and `prune`)
keeps compaction or pruning from deleting a partition file mid-append; a stale lock whose recorded pid is dead (or that a crash left empty) is auto-broken by an atomic
rename-aside-then-verify, so two racing breakers cannot both win; release deletes the lock only
while its random token is still ours; and SIGINT/SIGTERM release the
lock before exiting. Error redaction (D6, `src/events/error.ts`) covers known token shapes
(GitHub, Slack, AWS, GitLab, npm, OpenAI-style, Stripe, Google API), `user:pass@` URL credentials,
bare JWTs, PEM private-key blocks, query-string values, and secret-named keys (`password`,
`client_secret`, `AccountKey`, …) in `key=value`, JSON (quoted values whole) and `--flag value` forms; truncation caps the kept first line at the budget.
The JUnit sniff is head-anchored and DOCTYPE-bearing documents parse with entity expansion off
(no quadratic amplification); matrix cells serialize as JSON inside dedup/grouping keys
(`stableMatrix` in `src/store/dedup.ts`) so cell content can never collide two cells.

Adapter design: parsing is a pure `bytes → ParsedTest[]` transform; enrichment (`buildEvent` adds
`id`/`run`, and the matrix — preferring a per-test `matrix` the adapter sets over the collect
default) is separate and shared. The collect default comes from the **artifact name**
(`src/collect/matrix.ts`): a matrix job uploads its own artifact, so the name is the cell. This is
not cosmetic — the dedup key includes `matrix`, so an always-empty one collapsed every cell of a
test onto one key and silently dropped all but the first (a Firefox-only failure was undetectable).
`--matrix-from-artifact` takes a regex whose named groups become the dimensions; without one the
cell is the opaque `{ artifact: <name> }`. `--exclude-artifact` drops roll-up artifacts by glob
before download, so a merged report cannot double-count the per-cell results. Extraction tags each
file with its source artifact (`ExtractedFile`); do not flatten that away again. Add new formats as adapters, not by touching the pipeline. The
fetch loop takes an `onProgress` callback so `collect` can show live progress on long backfills.
Playwright blob artifacts are double-zipped, so `extractZipNested` recurses one nested level,
drawing every nested archive from one decompression budget per artifact. Pure logic (window, classification, run filtering/capping, repo parse,
state, glob matching, partitioning, prune cutoff, extract, fetch orchestration, redaction,
fingerprint, JUnit parse, event build, dedup, watermark, NDJSON append, manifest-path
selection) is unit-tested; only the raw Octokit calls (`listRunsSince`, `getRun`,
`listRunArtifacts`, `downloadArtifactZip`, `listRepoTree`) are left to integration. Artifact fetching runs up to
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
- **Test identity:** `id = hash(file + title_path)` only, with `file` normalized first
  (`normalizeTestFile`: `/` separators, GitHub-hosted runner workspace root stripped). The matrix (browser, viewport, …) is *always
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
