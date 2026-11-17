# 0006 — Redact and truncate error messages by default

**Status**: Accepted

## Context

Failure messages routinely embed huge HTML dumps, response bodies and secrets
— tokens, credentials in URLs, keys. Stored verbatim they bloat the partitions
and turn a git-friendly data directory into a secrets leak. The analytical value
lives in the first line; clustering is the fingerprint's job (0007).

## Decision

`src/events/error.ts` redacts, then truncates, every stored message:

- known token shapes (GitHub, Slack, AWS, GitLab, npm, OpenAI-style, Stripe,
  Google API), `user:pass@` URL credentials, bare JWTs, PEM private-key blocks,
  query-string values, and secret-named keys (`password`, `client_secret`,
  `AccountKey`, …) in `key=value`, JSON and `--flag value` forms;
- only the first line is kept, capped at the limit (default 400 characters), so
  the budget holds even for a single-line dump.

`--full-errors` bypasses both.

## Consequences

- Stored data is safe to commit and share by default.
- Some useful detail beyond the first line is lost unless `--full-errors` is
  used, which a user opts into knowingly.
- Redaction is pattern-based: a novel secret shape can slip through until a
  pattern is added.
