# 0020 — Advise on retries only where suitevitals records each attempt

**Status**: Accepted

## Context

Pass-after-retry is the strongest flake signal, but it exists only when the
test runner retries and the stored report keeps every attempt. `doctor` already
detects the framework, so it can say whether retries are on. Turning retries on
is not always good for suitevitals:

- **Playwright** blob reports record every retry, which become `attempts[]`;
  its JUnit and HTML reporters keep only the final attempt.
- **Maven Surefire with JUnit 4/5**: `rerunFailingTestsCount` writes
  `<flakyFailure>`/`<rerunFailure>`, which the JUnit adapter reads as attempts.
- **Surefire with TestNG** does not support `rerunFailingTestsCount`, and a
  Gradle test-retry run writes repeated `<testcase>` entries that the adapter
  does not merge, so it would record them as duplicates.
- **Cypress**: the Mochawesome adapter reads one attempt per test. With retries
  on, a failure a retry rescued is stored as a plain pass and never reaches the
  flake score.

## Decision

- `retryConfigPaths` picks Playwright and Cypress configs and `pom.xml` files
  (at most 6), then workflow YAML (at most 4, capped apart so workflows never
  crowd out a config), from the tree listing, shallowest first, never
  `node_modules`; `doctor` reads them into `RepoSignals.configFiles`.
- `adviseRetries` (pure) returns:
  - `suggest` for Playwright when a config names the `blob` reporter, no
    config sets a non-zero `retries` and no workflow passes `--retries=N`;
  - `suggest` for Maven when no `pom.xml` uses TestNG and neither the poms nor
    the workflows mention `rerunFailingTestsCount`;
  - `warn` for Cypress when the config sets non-zero `retries` or `runMode`;
  - nothing otherwise, including when no config could be read.
- The advice is printed whether or not the repo already uploads reports.

## Consequences

- Detection is a text match, not a parse: a retry count set through an
  imported constant or an environment variable reads as "on", so `doctor` errs
  toward staying quiet.
- `doctor` reads up to 10 more files per run.
- TestNG, Gradle and Vitest/Jest/Mocha projects get no retry advice until their
  retries can be recorded as attempts.
