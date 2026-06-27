---
name: validate-adapter
description: Validate a report-format adapter end-to-end against a live GitHub repo — run collect, confirm parsed counts, prove D12 idempotency on re-run, check month-partitioning, then clean up scratch data. Use after building or changing an adapter and you want real-data confidence, not just unit tests.
---

# Validate an adapter against real CI artifacts

Unit tests prove the parse logic; this proves the whole pipeline ingests a real repo's
artifacts correctly and idempotently. Run it after `adapter-author` (or any adapter change).

Pick a scratch workdir under the session scratchpad (never `/tmp` directly, never the repo's
`data/`):

```
WORK=<scratchpad>/sv-validate
```

## Steps

1. **First collect.** Run against the target repo into the scratch dir:
   ```bash
   npm run dev -- collect --repo <owner/name> --data-dir "$WORK/data" --state-file "$WORK/state.json"
   ```
   Watch the live progress line; if it goes silent on a long backfill, something is wrong.

2. **Confirm parse coverage.** The summary reports files parsed and events written. For the
   format under test, spot-check that the parsed test count for a report equals that report's
   own declared total (e.g. mochawesome `stats.tests`, JUnit `testsuite@tests`).
   - To read a single extracted report, use a tiny node script, **not** `head`/`cat` over
     globs — `head -1 *.json` injects `==>` banners that break `JSON.parse`.

3. **Prove idempotency (D12).** Re-run the *exact same command*. It MUST write **0** new
   events — the `(run_id, run_attempt, id, matrix)` dedup absorbs the overlap. A non-zero
   second run is a bug, report it.

4. **Check partitioning (D1).** Events land in `data/<owner>__<repo>/<YYYY-MM>.ndjson`,
   partitioned by each run's month. Confirm a backfill spanning a month boundary split
   correctly, and that `framework` and `matrix` on the records match expectations (flat
   formats → `matrix` is `{}`).

5. **Clean up — but confirm first.** The scratch data is disposable, but **ask before
   deleting** if there's any chance the user wanted to keep it. On approval:
   ```bash
   rm -rf "$WORK"
   ```

## Report back

A short summary: repo + window, artifacts → files parsed → events written, the parsed-vs-declared
spot check, the re-run delta (must be 0), the partitions touched, and confirmation the scratch
dir was removed. Flag any mismatch rather than smoothing it over.
