# Architecture Overview

Suitevitals is a CLI-first, zero-infrastructure tool that retroactively ingests the CI
test-report artifacts a repo already uploads, normalizes them into plain files you own,
and reports on test flakiness. No server, no instrumentation changes.

These documents capture the **durable architecture** — the decisions and data shapes that
constrain the code. They are updated as each milestone lands.

## Data flow

```
GitHub Actions artifacts
        │  (tiered discovery + download)
        ▼
   adapters  ──►  JUnit · Playwright JSON · Mochawesome
        │  (normalize)
        ▼
   NDJSON events   data/<owner>__<repo>/<YYYY-MM>.ndjson
        │  (streaming aggregation)
        ▼
   reports + dashboard
```

The collector authenticates once (single Octokit transport), lists workflow runs since a
stored watermark, downloads report artifacts, dispatches a framework adapter by sniffing the
extracted files, and appends normalized events with a dedup key so re-runs are always safe.

Reporting reads the same files back: it streams a repo's NDJSON partitions one line at a time
(never loading the whole history) and folds them into one rollup per test — collapsed across
matrix cells, or per `(test, matrix cell)` as a report-time option — carrying the raw flake
signals (pass-after-retry, intermittence, fingerprint diversity). A flakiness score then blends
those signals into a 0–100 number, built on the premise that flaky means *inconsistent* — so a
test that always fails the same way (broken, not flaky) scores near zero, and small samples are
held below a minimum-runs threshold.

## Document map

- [decisions.md](decisions.md) — the locked architecture decisions (D1–D12) with rationale.
- [event-schema.md](event-schema.md) — the NDJSON event record and `state.json`.
- [collector.md](collector.md) — the `collect` CLI surface and pipeline stages.
