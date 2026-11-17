# 0014 — Require Node.js 24 or newer

**Status**: Accepted

## Context

The minimum Node version decides which runtime APIs the code may use and which
versions CI has to prove. For a while `engines` said 24 but local development
ran on Node 22, so the code had to avoid Node 24 APIs to keep the dev loop
working — a floor that was neither enforced nor tested.

## Decision

Node 24 is the floor everywhere: `engines.node` is `>=24`, local development
runs on 24, and CI runs audit, `biome ci`, typecheck, tests and build on a
Node 24 and Node 26 matrix (`.github/workflows/ci.yml`).

## Consequences

- Node 24 runtime APIs are fine (built-in zstd, 0013, among them), but nothing
  newer than 24 — 26 is tested, not required.
- Users on older Node get an engines warning from npm and are unsupported.
- The required status checks on `main` are named after the matrix
  (`build (24)`, `build (26)`), so changing the matrix means updating the
  branch ruleset too.
- When a Node line reaches end-of-life, raise the floor and the matrix
  together.
