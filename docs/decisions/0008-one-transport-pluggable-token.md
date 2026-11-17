# 0008 — One GitHub transport, pluggable token resolution

**Status**: Accepted

## Context

Most users already have the GitHub CLI signed in, CI has `GITHUB_TOKEN`, and
some want to pass a token explicitly. Supporting `gh` by shelling out for API
calls would mean maintaining a second transport with its own paging, errors and
rate limiting.

## Decision

There is a single Octokit transport (`src/github/client.ts`). Only token
resolution is pluggable (`src/github/auth.ts`): `--token` → `GITHUB_TOKEN` →
`gh auth token` → a clear `AuthError`. `resolveToken` takes injectable `env` and
`runGhCli`, so the chain is unit-tested without spawning `gh` or touching
`process.env`. Rate-limit and transient-error backoff live at the transport via
`@octokit/plugin-throttling` and `@octokit/plugin-retry`, so it covers every
call.

## Consequences

- GitHub CLI users get zero-config auth; there is one code path for every API
  call.
- `gh` is only ever run to read a token.
- Anything else touching the outside world should mirror this injection style
  so it stays unit-testable.
