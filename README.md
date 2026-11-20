# suitevitals

[![CI](https://github.com/adrianjiga/TestSuiteVitals/actions/workflows/ci.yml/badge.svg)](https://github.com/adrianjiga/TestSuiteVitals/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/suitevitals)](https://www.npmjs.com/package/suitevitals)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Flaky-test reports for GitHub Actions, built from the test-report artifacts your CI already
uploads.

```bash
npx suitevitals collect --repo owner/name
npx suitevitals report --repo owner/name
```

## The problem

Flaky tests are easy to notice and hard to measure:

- a test fails, passes on retry, and the build goes green, so nobody records that it failed;
- the evidence sits in CI artifacts that expire after a few weeks and that nobody reads;
- the tools that track flakiness usually need a server, an account, or a change to how the
  tests run.

suitevitals reads the artifacts you already have, keeps the results as plain files you own, and
tells you which tests are flaky, how badly, and where. No server and no changes to your tests.

## What it does

1. **Finds the reports** in your GitHub Actions runs: artifacts with report-like names first,
   and if a run has none, it looks inside the other artifacts too.
2. **Reads JUnit XML, Playwright blob reports and Mochawesome JSON**, one record per test per
   run per matrix cell, with error messages redacted.
3. **Stores the results** as monthly NDJSON files under `data/<owner>__<repo>/`. Re-running
   `collect` picks up where it left off and never writes a duplicate.
4. **Ranks the tests** by a flake score, as a terminal table, JSON or a self-contained HTML
   dashboard.

## How tests are scored

Each test gets a score from 0 to 100. Flaky means _inconsistent_, so a test that always passes,
or always fails the same way (broken, not flaky), scores near zero. The score blends four
signals:

| Signal                                                       | Weight |
| ------------------------------------------------------------ | ------ |
| Passed only after a retry                                    | 0.35   |
| Flipped between pass and fail across push and scheduled runs | 0.30   |
| Both passed and failed on the same commit                    | 0.20   |
| Failed in more than one way (distinct stack signatures)      | 0.15   |

Skipped runs do not count. Recent runs count more: a run 14 days older than the newest one weighs
half as much (`--half-life`, or `off` to weigh all runs equally), so a test that was flaky months
ago and has passed since fades out. The blend is then discounted for small samples: a test keeps
`n / (n + 5)` of it, where `n` is its weighted passed-or-failed runs, so 1 bad run in 5 ranks below
20 in 100. A test with fewer than 5 such runs (`--min-runs`) is scored but set aside. The report
shows the signals next to the score, and a `WHY` column names the one worth the most points (for
example `flips 9/40` or `3 retry-passes`), so every ranking can be explained.

```text
Flaky tests · owner/repo · 3 tests

 SCORE  TEST                                            RUNS  RETRY%  INTERMIT  MODES  WHY
    25  webTables.spec.js › should delete a record          8    100%       0/8      2  8 retry-passes
     0  login.spec.js › remembers the session               8      0%       0/8      0

1 test(s) below the min-runs threshold hidden (--all to show).
```

## Commands

| Command                 | What it does                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `suitevitals collect`   | Download and parse test reports into `./data` (last 72 hours on the first run, then from where it left off)      |
| `suitevitals report`    | Rank a repo's tests by flake score (`--since`, `--half-life`, `--branch`, `--workflow`, `--by-matrix`, `--json`) |
| `suitevitals dashboard` | Write the same ranking as a self-contained HTML file with a sparkline per test                                   |
| `suitevitals doctor`    | Check that a repo uploads parseable reports, and print the reporter and upload YAML if not                       |
| `suitevitals compact`   | Compress closed months to `.ndjson.zst`; the current month stays uncompressed                                    |
| `suitevitals prune`     | Delete months older than `--keep-months` (`--dry-run` to preview)                                                |

Run `suitevitals <command> --help` for every flag.

A typical first run:

```bash
suitevitals doctor --repo owner/name      # will collection work for this repo?
suitevitals collect --repo owner/name     # writes state.json and data/ in the current directory
suitevitals report --repo owner/name      # rank the tests
suitevitals dashboard --repo owner/name   # writes owner__name.html
```

Run the commands from the same directory, or pass the same `--data-dir` to each.

### Settings that stick

To collect several repos with the same options every time, list them in a JSON file and pass it
with `--config`:

```json
{
  "hoursBack": 72,
  "excludeTriggers": ["pull_request"],
  "repos": [
    "owner/web-app",
    { "repo": "owner/api", "hoursBack": 168, "workflow": "e2e-*" },
    { "repo": "owner/web", "excludeArtifacts": ["final-test-report"] }
  ]
}
```

```bash
suitevitals collect --config repos.json
```

A repo's own settings override the command-line flags, which override the top-level defaults in
the file. [`repos.example.json`](repos.example.json) is a working example. See the
[CLI and config reference](docs/API-Interface-Design.md) for every key.

## Install

Needs Node.js 24 or newer.

```bash
npx suitevitals --help                # run without installing
npm install -g suitevitals            # or install it globally
npm install --save-dev suitevitals    # or per project
```

The command is `suitevitals` in every case.

### GitHub token

suitevitals looks for a token in this order:

1. `--token <token>`
2. the `GITHUB_TOKEN` environment variable
3. `gh auth token`, if the GitHub CLI is installed and signed in

It only reads. A fine-grained token needs **Actions: read** and **Contents: read** on the repos
you collect (`doctor` uses Contents). A classic token needs the `repo` scope for private repos and
no scope for public ones.

## Supported

- **Report formats**: JUnit XML (any `<testsuites>` or `<testsuite>` document, such as Maven
  Surefire, TestNG or the Jest and Vitest JUnit reporters), Playwright blob reports, and Mochawesome JSON (Cypress, Mocha).
- **CI**: GitHub Actions workflow artifacts.
- **Matrix builds**: Playwright reports carry their own project name. For the other formats, the
  cell comes from the artifact name, and `--matrix-from-artifact` can split it into named
  dimensions such as browser and viewport.
- **`doctor`** recognizes Playwright, Cypress, Vitest, Jest, Mocha and Java (Maven or Gradle)
  projects, including monorepos. For Playwright and Maven with JUnit it suggests turning on
  retries when they are off, and for Cypress it warns that retries hide rescued failures.
- **Output**: a terminal table, JSON, and a self-contained HTML dashboard with no runtime
  dependencies.

## Learn more

- [Troubleshooting](docs/troubleshooting.md): no reports found, missing tests, token and lock
  errors.
- [CLI and config reference](docs/API-Interface-Design.md): every flag, its default, and the config
  file.
- [Stored data and dashboard reference](docs/output-reference.md): what each record and file
  contains.
- [Architecture](docs/Architecture.md), [technical design](docs/Technical-Design.md) and
  [design decisions](docs/decisions/).
- [Changelog](CHANGELOG.md) and [releases](https://github.com/adrianjiga/TestSuiteVitals/releases).

## Contributing

Bugs and ideas go on the [issue tracker](https://github.com/adrianjiga/TestSuiteVitals/issues).
For the development setup and how changes get merged, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
