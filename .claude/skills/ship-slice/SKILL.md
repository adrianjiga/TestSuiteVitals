---
name: ship-slice
description: Drive a feature slice through the standard workflow with checkpoints — gate checks, logical-group commits, push, a PR with the Summary/Why/What-Changed sections, and (post-merge) a verify-before-delete branch cleanup. Use to ship a finished slice or to clean up after a merge. Pauses for approval at each gate; never auto-merges or auto-deletes.
---

# Ship a feature slice

A thin guardrail over the per-slice workflow. It does NOT barrel through — it pauses for
approval at each gate, because the irreversible steps (push, merge, branch delete) are yours
to confirm. Delegates the heavy lifting to the existing `/commit` and `/pr` skills.

## Pre-PR gates (all must pass)

1. `npm run check` (Biome lint+format+autofix) — must be clean.
2. `npm run typecheck` — the type gate CI runs.
3. `npm test` — full vitest suite.
4. Docs synced (run the `update-docs` skill) — README, CHANGELOG, `docs/…`, and `AGENTS.md`.

If any gate fails, stop and surface it; don't paper over it.

## Branch & commits

- If on `main`, branch first (`m<N>-<slug>`). Never commit feature work on `main`.
- **Commit in logical groups** — split a large change into coherent parts, one commit each
  (e.g. implementation, then tests, then docs). Single-line messages. **No AI/Claude
  co-author trailer.** Use `/commit`.

## PR

- Push, then open the PR with `/pr`. The body MUST have exactly these sections:
  **Summary**, **Why**, **What Changed**. Note any real-data validation (e.g. the
  `validate-adapter` result) under What Changed.
- Hand the PR URL back and stop. The user reviews and merges.

## Post-merge cleanup (only after the user confirms the merge)

1. **Verify the merge before deleting anything** (this gate is non-negotiable — a past branch
   delete happened before confirming):
   ```bash
   gh pr view <N> --json state,mergedAt,mergeCommit
   ```
   Proceed only if `state` is `MERGED` and `mergedAt` is set.
2. Sync main and delete the branch:
   ```bash
   git checkout main && git pull && git branch -d <branch> && git remote prune origin
   ```
3. Confirm the branch is gone and the tree is clean; then offer the next slice.

## Never

Auto-merge, force-push, or delete a branch without the verified-merge check above.
