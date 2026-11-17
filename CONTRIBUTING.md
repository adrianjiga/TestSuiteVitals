# Contributing to suitevitals

suitevitals is a command-line tool that reads the test-report artifacts GitHub Actions runs
upload, stores the results as plain NDJSON files, and ranks tests by how flaky they are. It
targets Node.js 24+.

Thanks for your interest. This file describes how to get set up and how to get changes merged.

## Getting started

Prerequisites:

- Node.js 24+ (older versions are not supported)
- npm

```bash
npm install
```

The project is pure ESM, written in TypeScript. `npm run build` compiles `src/` to `dist/`, which
is what gets published. During development, `npm run dev -- <args>` runs `tsx src/cli.ts`
directly, with no build step:

```bash
npm run dev -- collect --help
```

## Useful commands

| Command              | What it does                               |
| -------------------- | ------------------------------------------ |
| `npm run dev -- …`   | Run the CLI from source via tsx            |
| `npm test`           | Run the test suite once (vitest)           |
| `npm run test:watch` | Run the tests in watch mode                |
| `npm run typecheck`  | Type-check with `tsc --noEmit`             |
| `npm run check`      | Biome lint and format, applying safe fixes |
| `npm run lint`       | Biome lint only                            |
| `npm run format`     | Format every file with Biome               |
| `npm run build`      | Clean `dist/` and compile to it            |

To run one test file or the tests matching a name:

```bash
npx vitest run test/auth.test.ts
npx vitest run -t "precedence"
```

## Development workflow

Every change goes through a branch and a pull request against
[`main`](https://github.com/adrianjiga/TestSuiteVitals/tree/main).

1. Create a branch:

   ```bash
   git checkout -b <type>/<short-description>   # e.g. fix/junit-sniff
   ```

2. Commit in small, logical steps with single-line
   [conventional commit](https://www.conventionalcommits.org/) messages:

   ```text
   feat(adapters): parse TRX reports
   fix(collect): keep the watermark behind pending runs
   docs: explain the flake score
   ci: test on Node 26
   ```

3. Before pushing, make sure the checks pass:

   ```bash
   npm run check && npm run typecheck && npm test
   ```

4. Push and open a pull request. The PR description has exactly three sections: **Summary**,
   **Why** and **What changed**.

5. CI runs a production dependency audit, Biome, the type check, the tests and the build on
   Node 24 and 26. All checks must be green before merging.

`main` is protected by a ruleset: changes land only through pull requests, the `build (24)` and
`build (26)` checks are required, and a branch must be up to date with `main` before it merges.

## Testing conventions

- Tests live in `test/`, mostly named after the module they cover (`test/score.test.ts` for
  `src/report/score.ts`).
- Pure logic is unit-tested: windows, filtering, parsing, redaction, dedup, the watermark,
  scoring and the rest. Only the raw Octokit calls (`listRunsSince`, `getRun`,
  `listRunArtifacts`, `downloadArtifactZip`, `listRepoTree`, `listAttemptStarts`,
  `listRecentCompletedRuns`) are left to integration.
- Code that touches the outside world takes its dependencies as arguments. `resolveToken` takes
  an injectable `env` and `runGhCli`, so the token chain is tested without spawning `gh` or
  touching `process.env`. Follow the same style for new code.
- Tests that write files use a fresh directory from `mkdtemp` under `os.tmpdir()` and remove it in
  `afterEach`.
- Tests that expect a warning silence the console with
  `vi.spyOn(console, "warn").mockImplementation(() => {})` and restore it afterwards.
- A bug fix comes with a test that fails without the fix.

## Code style

- Biome handles linting and formatting: double quotes, 2-space indent, 100 columns. It also
  formats Markdown, except under `.claude/`. Let it own the style; don't hand-format.
- The code is ESM. Relative imports use `.js` specifiers, even from `.ts` files
  (`import { resolveToken } from "./auth.js"`).
- Comments are for things the code cannot say for itself.
- Keep the docs in `docs/` in step with behaviour. A decision with lasting trade-offs gets a new
  record in `docs/decisions/`.

## Releasing

Releases are maintainers-only:

1. Bump `version` in `package.json` and date the entry in `CHANGELOG.md`, in a pull request.
2. After it merges, create a GitHub release on `main` with the tag `v<version>`. A tag with a
   suffix such as `v0.2.0-rc.1` publishes under npm's `next` tag instead of `latest`.
3. `.github/workflows/publish.yml` then runs two jobs:
   - **Verify and pack** (no publishing rights) checks that the release commit is on `main` and
     the tag matches `package.json`, installs without dependency install scripts, runs the
     production audit, `biome ci`, the type check, the tests and the build, packs the tarball,
     checks that it boots and reports the tagged version, and uploads it.
   - **Publish** downloads that tarball and publishes it with scripts disabled, through trusted
     publishing (OIDC) with provenance. Only this job can request the publish token, and no
     project or dependency code runs in it. No npm token is stored in the repository. If that
     version is already on npm (for example after a manual publish), it logs a notice and skips
     publishing instead of failing.
