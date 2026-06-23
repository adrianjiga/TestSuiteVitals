# Event Schema

One NDJSON record per test, per workflow run, per matrix cell.

```json
{
  "schema_version": 1,
  "id": "a3f9c1...",
  "file": "tests/e2e/webTables.spec.js",
  "title_path": ["Web Tables", "should delete a record"],
  "framework": "playwright",
  "source": "artifact",
  "status": "passed",
  "flaky": true,
  "duration_ms": 2310,
  "attempts": [
    {"n": 1, "status": "failed", "duration_ms": 2100,
     "error": {"message": "Timed out waiting for...", "fingerprint": "e81b2d"}},
    {"n": 2, "status": "passed", "duration_ms": 2310}
  ],
  "run": {
    "provider": "github",
    "repo": "adrianjiga/PlaywrightAutomationExample",
    "run_id": 9981234,
    "run_attempt": 1,
    "workflow": "playwright-tests.yml",
    "branch": "main",
    "sha": "f3a91c2",
    "trigger": "schedule",
    "started_at": "2026-06-10T07:00:14Z"
  },
  "matrix": {"browser": "firefox", "viewport": "desktop", "group": "@ui"},
  "collected_at": "2026-06-10T09:12:00Z"
}
```

## Field notes

- `id` — stable hash of `file + title_path` only (see [D5](decisions.md#d5--test-identity-hashfile--title_path)).
- `attempts[]` — filled by rich adapters (Playwright JSON, Mochawesome); the generic JUnit
  adapter emits a single attempt. Top-level `status` and `flaky` are **derived** so simple
  consumers never parse the array.
- `flaky` (per-event) — passed after at least one failed attempt.
- `run.run_attempt` — a human clicking "re-run failed jobs" is a signal the test reporter
  never sees. GitHub may overwrite artifacts on re-run, so deep per-attempt artifact history
  is not reliably fetchable; record the attempt number and parse what exists.
- `error` — redacted and truncated per [D6](decisions.md#d6--error-storage-redacted--truncated-by-default);
  `fingerprint` per [D7](decisions.md#d7--failure-clustering-stack-frame-fingerprint).

## State file (`state.json`)

```json
{
  "schema_version": 1,
  "repos": {
    "adrianjiga/PlaywrightAutomationExample": {
      "watermark": "2026-06-09T07:14:00Z",
      "pending_runs": [9981301],
      "last_collected_at": "2026-06-10T09:12:00Z"
    }
  }
}
```

The watermark advances only after a durable append and never past an in-progress run
(see [D12](decisions.md#d12--crash-safety--idempotency)). `pending_runs` holds in-progress or
queued runs to re-check on the next collection.
