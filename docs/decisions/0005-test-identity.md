# 0005 — Identify a test by hash(file + title_path) only

**Status**: Accepted

## Context

A test's history is only useful if every run of it lands on one identity. The
same test runs in several matrix cells (browser, viewport, shard group), on
several runners, and under several reporters, each of which describes its
location differently.

## Decision

`id = hash(file + title_path)`. The matrix is _always a dimension, never
identity_; grouping by matrix is a report-time option (`--by-matrix`).

`file` is normalized before hashing (`normalizeTestFile` in
`src/events/event.ts`): `\` becomes `/`, and a GitHub Actions workspace root —
hosted Linux, Windows and macOS, self-hosted `…/_work/<repo>/<repo>/`, or a
container job's `/__w/<repo>/<repo>/` — is stripped. Mochawesome's relative
`file` is preferred over Mocha's absolute `fullFile`.

`file` must be a _location_, never a run label. Adapters resolve it from the
most location-like attribute available; for JUnit the order is
`testcase@file → testsuite@file → classname → testsuite@name → "unknown"`,
because TestNG/Surefire emits a different `<testsuite name>` per suite XML and
once split one test's history three ways.

## Consequences

- One canonical history per test; toggling `--by-matrix` never orphans data.
- Relative paths and class names are unchanged by normalization, so their ids
  are too.
- An identity _bug fix_ necessarily re-keys history and has no migration: the
  affected repo's partitions must be deleted and re-collected, bounded by
  GitHub's artifact retention. Data collected earlier from an absolute- or
  backslash-path emitter keeps its old ids. Weigh that cost before changing how
  any adapter resolves `file` or `title_path`.
