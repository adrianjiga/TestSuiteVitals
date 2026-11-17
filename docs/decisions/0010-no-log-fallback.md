# 0010 — No log-scraping fallback; `doctor` instead

**Status**: Accepted

## Context

When a repo uploads no report artifacts, scraping job logs is the obvious
fallback. But logs are the worst source for retry data — the signal that
matters most for flakiness — and every framework formats them differently.

## Decision

Do not parse logs. Instead, the `doctor` command inspects a repo's recent runs
for report-looking artifacts and, if there are none, detects the framework and
prints the exact reporter and `upload-artifact` YAML to add. Revisit log
parsing only on real demand.

## Consequences

- Every stored event comes from a structured report, with real per-attempt
  data.
- A repo without report artifacts yields nothing until its CI is changed; the
  gap is turned into onboarding.
- The event schema reserves a `source` field (0011) so log-derived events would
  stay distinguishable if this is ever revisited.
