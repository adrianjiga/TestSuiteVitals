# 0007 — Cluster failures by a stack-frame fingerprint

**Status**: Accepted

## Context

To tell "these 14 failures are the same failure" from "this test fails in 14
different ways", failures need a stable cluster key. The message cannot be it:
it is redacted and truncated (0006), and often carries timestamps, ids and
ports that differ on every run.

## Decision

`error.fingerprint = hash(normalized stack frames)`, with paths, line and column
numbers, timestamps and addresses masked before hashing (`src/events/error.ts`).

## Consequences

- Clustering is independent of message redaction and truncation.
- Failure-mode diversity — distinct fingerprints beyond the first — is one of
  the flake-score signals.
- It is the hook for future failure classification.
- A failure without a stack is fingerprinted from its message instead, which
  is less stable; a refactor that renames frames changes the fingerprint.
