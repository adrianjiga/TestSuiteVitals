# AGENTS.md

TypeScript CLI (npm package and command `suitevitals`) that ingests CI test-report artifacts from
GitHub Actions, normalizes them into plain git-friendly NDJSON, and reports flaky tests. No server,
no instrumentation. Node >=24, ESM.

## Commands

- `npm run dev -- <args>` — run the CLI from source via tsx, e.g. `npm run dev -- collect --help`.
- `npm test` — the full vitest suite once (`npm run test:watch` to watch). Single file:
  `npx vitest run test/auth.test.ts`. By name: `npx vitest run -t "precedence"`.
- `npm run typecheck` — `tsc --noEmit`, the type gate.
- `npm run check` — Biome lint + format + import order with autofix. Run it before every commit.
  `npm run lint` / `npm run format` run the halves.
- `npm run build` — cleans `dist/` and compiles `src/` into it. `prepublishOnly` runs tests + build.
- CI (`.github/workflows/ci.yml`, Node 24 and 26 matrix, read-only `GITHUB_TOKEN`):
  `npm audit --omit=dev --audit-level=high` → `biome ci .` → typecheck → test → build.
- Node 24 everywhere — `engines`, CI and local dev. The maintainer's nvm _default_ alias is still
  22.19, so a non-interactive shell can resolve Node 22; put Node 24 first on `PATH` (e.g.
  `nvm use 24`) before running the gates.

## Repository rules and releases

- `main` is protected by the GitHub ruleset "main protection" (configured on GitHub, not in the
  repo): PRs only, no force-push or deletion, 0-approval solo merge, required status checks
  `build (24)` and `build (26)` with branches up to date with `main`, and a `code_quality` rule
  (errors only) backed by CodeQL default setup. Changing the CI matrix renames the checks, so
  update the ruleset's required checks with it.
- Releasing: in a PR, bump `package.json` (+ lockfile) and date the `CHANGELOG.md` section. After
  merge, publish a GitHub release tagged `v<version>`; that triggers
  `.github/workflows/publish.yml`: a `verify` job (no `id-token`) checks the commit is on `main`
  and the tag matches `package.json`, runs every gate, packs and boot-checks the tarball; a
  `publish` job (the only one with `id-token: write`) stages that tarball with
  `npm stage publish --ignore-scripts` via OIDC trusted publishing with provenance (no npm token).
  The trusted publisher only allows staging, so a maintainer must then approve it with 2FA
  (`npm stage approve <stage-id>` or npmjs.com → Staged Packages) before it is public. A `-` in
  the tag stages under `--tag next`. A version already on npm is skipped with a notice, not failed.

## Architecture

Deeper docs: `docs/Architecture.md`, `docs/Technical-Design.md`, `docs/API-Interface-Design.md`,
`docs/output-reference.md`, `docs/troubleshooting.md`, and the decision records in
`docs/decisions/` (cited below by number).

- `src/cli.ts` — citty entry; registers the subcommands in `src/commands/`, each wrapped by
  `withCleanErrors` (a thrown error prints one `Error: …` line and exits 1; `SUITEVITALS_DEBUG=1`
  prints the stack).
- Auth (0008): `src/github/auth.ts` resolves `--token` → `GITHUB_TOKEN` → `gh auth token` →
  `AuthError`; `src/github/client.ts` is the _single_ Octokit transport, with rate-limit/transient
  backoff from `@octokit/plugin-throttling` + `@octokit/plugin-retry` covering every call. Its
  `quietLog` drops the request-log plugin's automatic `… - 404 with id …` line, because `doctor`
  probes maybe-absent files (the error still throws and is handled).
- `collect` pipeline: auth → load state (`src/state/state.ts`) → window (`src/collect/window.ts`)
  → list runs + re-fetch tracked pending ids (`src/github/runs.ts`; `listRunsWindowed` splits
  `created` ranges past GitHub's 1000-result cap) → filter by policy + cap
  (`src/collect/filter.ts`) → classify → fetch + extract artifacts (`src/github/artifacts.ts`
  list/match/download, `src/artifacts/extract.ts` unzip via fflate, `src/artifacts/fetch.ts`
  orchestrates) → parse (`src/collect/parse.ts` walks files, `src/adapters/` dispatches by content
  sniff) → build events (`src/events/event.ts` schema/identity, `src/events/error.ts`
  redaction/fingerprint) → append (`src/store/` partition/dedup/append) → advance the watermark
  (`src/collect/watermark.ts`).
- Artifacts (0009): name matches are downloaded; only when a run has _none_, its other artifacts
  under `--max-artifact-mb` (default 100) are sniffed. Extraction is zip-slip-guarded and capped by
  a declared-size decompression budget (zip bombs skipped before inflating; an over-budget match
  skipped before download); Playwright blobs are double-zipped, so `extractZipNested` recurses one
  level from one budget per artifact. Any extraction or parse failure costs only that
  artifact/file, with a warning; oversized and expired candidates are counted, never silently
  dropped. Runs are fetched `--concurrency` at a time (`p-limit`, default 5), then folded in input
  order so output stays deterministic. `onProgress` drives live progress on long backfills.
- Adapters: parsing is a pure `bytes → ParsedTest[]` transform; `buildEvent` adds `id`/`run` and
  the matrix (a per-test adapter `matrix` wins over the collect default). JUnit
  (`src/adapters/junit.ts`; one attempt per test unless Surefire recorded `flakyFailure`/
  `rerunFailure`), Playwright blob (`src/adapters/playwright-blob.ts`; `report.jsonl` teleReporter
  events, per-retry `attempts[]`, matrix from project name), Mochawesome
  (`src/adapters/mochawesome.ts`; Cypress/Mocha `stats` + `results`, flat, no matrix).
- Matrix: the collect default is the **artifact name** (`src/collect/matrix.ts`) — a matrix job
  uploads its own artifact. `--matrix-from-artifact <regex>` turns named groups into dimensions;
  otherwise the cell is `{ artifact: <name> }`. Extraction tags each file with its source artifact
  (`ExtractedFile`); don't flatten that away — an always-empty matrix once collapsed every cell
  onto one dedup key and silently dropped all but the first. `--exclude-artifact` drops roll-up
  artifacts before download so merged reports can't double-count.
- Multi-repo: repeatable `--repo` and/or `--config` (`src/collect/config.ts`; `resolveTargets`
  merges per-repo override → CLI flag → config default → built-in for `hoursBack`, `concurrency`,
  `workflow`, `excludeTriggers`, de-duping repos). Repos run sequentially via `collectRepo` over one
  client/state file/data dir; state is saved per repo, and one repo's failure exits non-zero while
  the rest still collect. `collect`'s own flags are validated in `src/commands/flags.ts` (reusing
  the config file's `optionalString`/`optionalPattern` rules) before the config file is read or any
  network call is made.
- Policy filters (`--workflow` glob, `--exclude-trigger`) may let the watermark pass excluded runs,
  so filtering never stalls collection; `--exclude-trigger pull_request` keeps fork-PR artifacts
  out. `--max-runs` caps a backfill oldest-first (`capRuns`/`watermarkDisposal`); the watermark
  never passes a deferred run.
- Re-runs (0016): listing reaches `--rerun-lookback-hours` (default 48) behind the window, and
  `src/collect/rerun.ts` keeps a run from that stretch only when its attempt beats `rerun_attempts`
  in state. Each artifact's events carry the attempt that uploaded it (`attemptForArtifact`).
- Reporting (`src/report/`): `read.ts` streams events line by line, oldest month first (0003);
  `aggregate.ts` folds them into one `TestAggregate` per `id` (or `(id, matrix)` with
  `--by-matrix`) holding raw signals only; `score.ts` gives a 0–100 flake score — flaky means
  _inconsistent_, so a consistently failing test scores ~0 — blending pass-after-retry (0.35),
  flip rate (0.30: pass↔fail transitions between consecutive `push`/`schedule` runs per
  `(branch, matrix cell)`, ×3 and capped at 1), same-commit intermittence (0.20) and
  failure-mode diversity beyond the first (0.15) over passed + failed runs (0017), then
  discounted by confidence `n / (n + 5)` (0018; `rawScore` keeps the undiscounted blend). Scoring
  reads `aggregate.weighted`: each run weighs `2^(−age / half-life)` from the newest run (0019,
  `--half-life`, default `14d`, `off` disables), while confidence and the `RUNS`, `RETRY%` and
  `INTERMIT` columns use real counts;
  under `--min-runs` (default 5) is flagged `eligible: false`, a display filter only. `rank.ts`
  splits and sorts; `render.ts` prints a table or `--json`, both with `explain.ts`'s `WHY` text
  for the score's `topSignal`. `report` flags: `--by-matrix`,
  `--min-runs`, `--since <Nd|ISO>`, `--half-life`, `--branch`, `--workflow` (shared
  `matchesGlob`), `--limit`, `--all`; `dashboard` takes the same event filters.
- `dashboard` (`src/report/dashboard.ts`): one self-contained HTML file (inline CSS, no runtime
  deps), a heartbeat sparkline per test from the `Aggregator`'s opt-in `timeline` (off for
  `report`, so it pays no memory cost).
- `compact` (`src/store/compact.ts`, 0002, 0013) zstd-compresses closed months to `.ndjson.zst` via
  `src/store/compress.ts` (built-in `node:zlib`; reads files the old `@mongodb-js/zstd` wrote). The
  reader (`read.ts`) and append-dedup (`ndjson.ts`) read both forms; while both forms of a month
  coexist the reader dedups by key, and the next `compact` merges them, deduping during the merge.
  Unparseable lines are warn-and-skipped by readers and kept verbatim by `compact`. `prune`
  (`src/store/prune.ts`) deletes months older than `--keep-months` (the current month counts and
  always survives); `--dry-run` previews.
- `doctor` (`src/commands/doctor.ts`) inspects recent runs for report-like artifacts and, if none,
  prints the reporter + `upload-artifact` YAML fix (0010). `src/doctor/diagnose.ts` is pure
  (`detectFramework` → fix table) over signals from `src/github/contents.ts`: one git-trees listing
  finds monorepo `package.json` files (`packageJsonPaths`: shallow, capped at 5, no
  `node_modules`) and Java build files, falling back to root-only probes for huge/empty repos.
  `retryConfigPaths` adds runner configs and `pom.xml` (at most 6), then workflows (at most 4),
  and `adviseRetries` suggests retries only where each attempt is recorded (Playwright with the
  blob reporter, Maven + JUnit) and warns for Cypress, whose Mochawesome reports keep one
  attempt (0020).
- Color (`src/colors.ts`): a semantic `Palette` over picocolors; `createPalette(false)` is a no-op,
  so renderers take an injected palette and default to plain. Color is applied _after_ padding;
  `--json` is never colored. Artifact-derived text goes through `terminalSafe` before printing;
  `--json` and the dashboard escape it themselves.

## Locked design invariants

- **Data layout** (0001, 0011): `data/<owner>__<repo>/<YYYY-MM>.ndjson`, one record per test per
  run attempt per matrix cell, every record with `schema_version`.
- **Identity** (0005): `id = hash(file + title_path)` only, `file` normalized by
  `normalizeTestFile` (`/` separators, workspace root stripped). The matrix is _always a dimension,
  never identity_. `file` must be a location, never a run label; an identity change re-keys
  history with no migration.
- **Idempotency** (0012): dedup key `(run_id, run_attempt, id, matrix)`, matrix serialized by
  `stableMatrix`. Append and fsync _first_, then advance the watermark and save `state.json`
  (fsynced temp + rename). The watermark never passes an in-progress run; `pending_runs` are
  re-fetched by id. Running `collect` twice must write nothing new.
- **Locks** (0012): `<state-file>.lock` (`src/state/lock.ts`) rejects a concurrent `collect`;
  `<data-dir>/.lock` (`acquireDataDirLock`) is shared by `collect`, `compact` and `prune`. Stale
  locks are broken by atomic rename-aside-then-verify; release only deletes a lock still holding
  our token; SIGINT/SIGTERM release before exiting.
- **Errors** (0006, 0007): redacted + first line truncated by default (`--full-errors` bypasses);
  `error.fingerprint` hashes normalized stack frames. The JUnit sniff is head-anchored and
  DOCTYPE documents parse with entity expansion off.

## Gotchas

- Some `src/` files contain literal NUL/ESC bytes: macOS `grep` silently skips them (use
  `grep -a`), and Read renders them invisibly.
- `PLAN.md` (the fuller design doc) is local-only via `.git/info/exclude`. Never commit it.
- Demo repos: only SeleniumAutomationExample (TestNG/Surefire) uploads JUnit XML; the Playwright
  demos upload blob-report zips and Cypress uploads mochawesome JSON.
- `--hours-back` only _widens_ the window past the watermark; it never narrows it.
- A re-run older than the lookback is collected only by a `--hours-back` backfill over its creation
  date (0016).

## Testing conventions

- Tests live in `test/`. Pure logic is unit-tested: window, classification, run filtering/capping,
  repo parse, state, glob matching, partitioning, prune cutoff, extract, fetch orchestration,
  redaction, fingerprint, adapters, event build, dedup, watermark, NDJSON append, manifest-path
  selection, flag parsing.
- `test/helpers/events.ts` builds `TestEvent`s (`ev`, `failed`, `hour`) and a seeded PRNG
  (`seeded`). Scoring behaviour is pinned by scenario fixtures in `test/score.test.ts` that run
  event streams through `aggregate()` → `scoreTest()`; a formula change must keep them passing.
- Only the raw Octokit calls are left to integration: `listRunsSince`, `getRun`,
  `listRunArtifacts`, `downloadArtifactZip`, `listRepoTree`, `listAttemptStarts`,
  `listRecentCompletedRuns`.
- Inject anything that touches the outside world, as `resolveToken` takes `env` and `runGhCli`, so
  tests never spawn processes or read `process.env`. The one exception is
  `test/collect-cli.test.ts`, which runs the real CLI to prove flags are rejected before
  authentication, with a dummy token and scratch state and data dirs. Renderers default to the plain palette, so
  assert on colorless output.

## Conventions

- ESM throughout. Relative imports **must** use `.js` specifiers even from `.ts` (NodeNext), e.g.
  `import { resolveToken } from "./auth.js"`.
- Biome owns style (double quotes, 2-space, 100 columns) — never hand-format. It formats Markdown
  too (padded tables, `_emphasis_`), except under `.claude/`. `useMathMinMax` is off because it
  misfires on ISO-string comparisons (0015).
- Comments only for what the code cannot say for itself.
- Add new report formats as adapters, not by touching the pipeline.
- Long-running operations show live progress; never go silent.
- GitHub Actions are SHA-pinned with a `# vX.Y.Z` comment (Dependabot reads it). Use the latest
  stable versions when adding packages or actions.
- After each change, update `README.md`, the affected `docs/` files and this file, and add a
  `docs/decisions/` record for any decision with a lasting trade-off.
