# Locked Architecture Decisions

These decisions are locked with their rationale so future contributors (human or AI)
understand the "why" behind each choice. Revisit only with a documented reason.

## D1 — Source of truth: partitioned NDJSON

Store events as `data/<owner>__<repo>/<YYYY-MM>.ndjson`.

**Why:** plain, inspectable, git-friendly; monthly partitioning prevents the read-time pain
of one ever-growing file.

## D2 — Compression: zstd on closed months

A `compact` command compresses closed months to zstd; the current month stays uncompressed.

**Why:** ~10x on JSON, while keeping cheap appends for the active month.

## D3 — Query layer (v1): in-process streaming aggregation

**Why:** instant at personal scale; zero native dependencies.

## D4 — Query layer (growth path): DuckDB / Parquet

Reserved escape hatch over the same files.

**Why:** designed-in scaling path; no data migration ever required.

## D5 — Test identity: hash(file + title_path)

`id = hash(file + title_path)` only. The matrix (browser, viewport, group) is **always a
dimension, never identity**. "Matrix joins identity" is a **report-time** grouping option.

**Why:** one canonical history per test; changing the grouping setting never orphans
collected data.

`file` is normalized before hashing (`normalizeTestFile`): `\` becomes `/` and a GitHub Actions
workspace root (`/home/runner/work/<repo>/<repo>/`, `D:\a\<repo>\<repo>\`, the macOS equivalent,
a self-hosted `…/_work/<repo>/<repo>/` or a container job's `/__w/<repo>/<repo>/`) is stripped, so
emitters that write absolute or OS-native paths still give a test one id across runners. Mochawesome's relative `file` is preferred over Mocha's absolute `fullFile`.
Relative paths and class names are unchanged by this, so their ids are too; only data collected
earlier from an absolute- or backslash-path emitter keeps its old ids, and re-collecting an
overlapping window would add those tests again under the new ones.

**Corollary — `file` must be a location, never a run label.** Identity is only stable if both
inputs are. Adapters therefore resolve `file` from the most location-like attribute available
and never from something that varies with *how the run was invoked*. The JUnit adapter learned
this the hard way: it ranked `<testsuite name>` above `<testcase classname>`, and TestNG/Surefire
emits a different suite name per suite XML (`TestSuite` for `testng.xml`, `UI Tests` for
`testng-ui.xml`, the class name when Surefire writes per-class files). One test picked up three
identities and its history split three ways. Resolution order is now
`testcase@file → testsuite@file → classname → testsuite@name → "unknown"`.

**Caveat this decision does not cover:** the "never orphans collected data" guarantee is about
the report-time `--by-matrix` toggle. An identity *bug fix* necessarily re-keys history, and
there is no migration path — the affected repo's partitions must be deleted and re-collected,
bounded by GitHub's artifact retention. Weigh that cost before changing how any adapter resolves
`file` or `title_path`.

## D6 — Error storage: redacted + truncated by default

Redact credentials, tokens, query strings; truncate to a configurable limit (~400 chars —
only the first line is kept, itself capped at the limit, so the budget holds even when the
bloat is a single-line dump). `--full-errors` bypasses both.

**Why:** failure messages embed huge HTML dumps, response bodies, and secrets; the analytical
value lives in the first lines; clustering is the fingerprint's job (D7), not the message's.

## D7 — Failure clustering: stack-frame fingerprint

`error.fingerprint = hash(normalized stack frames)` with paths, line numbers, and timestamps
masked.

**Why:** enables "these 14 failures are the same failure"; independent of message redaction;
the hook for future AI classification.

## D8 — Auth: one transport, pluggable token resolution

A single Octokit transport. Token resolution chain: `--token` → `GITHUB_TOKEN` →
`gh auth token` → clear error.

**Why:** GitHub CLI users get zero-config auth without maintaining a second transport.

## D9 — Artifact discovery: tiered

1. List names + sizes — no downloads.
2. Download report-glob matches: `*report*`, `*result*`, `*junit*`, `*blob*`, `*mochawesome*`.
   A match whose compressed size already exceeds the extraction budget is skipped (surfaced
   as oversized) *before* download — it could only fail that budget after ballooning memory.
3. Only if zero report-name matches were found, sniff remaining artifacts under
   `--max-artifact-mb` (default 100).

**Why:** zero-config robustness at ~5% of pure sniff-all bandwidth; failure videos and traces
never dominate collection.

## D10 — Log-fallback: cut from v1

Replaced by the `doctor` command; revisit on real demand.

**Why:** logs are the worst source for retry data (the metric that matters most); `doctor`
converts the gap into onboarding.

## D11 — Schema future-proofing

`schema_version` on every event; a `source` field ("artifact" or "logs") reserved now.

**Why:** old data stays parseable forever; degraded sources remain distinguishable if
log-fallback ever lands.

## D12 — Crash safety / idempotency

Dedup key = `(run_id, run_attempt, id, matrix)`. State advances **only after** a durable
append. The watermark never passes an in-progress run; an in-progress run the window listing
no longer surfaces (a wide `--hours-back` saw it once) is re-fetched by id from `pending_runs`
until it completes, so advancing past it never loses it.

**Why:** re-runs are always safe; nothing is silently skipped.
