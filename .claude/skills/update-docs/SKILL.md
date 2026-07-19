---
name: update-docs
description: Sync the docs after finishing a feature slice — update README.md, the relevant docs/architecture/ files, and CLAUDE.md, touching exactly the right sections. Use as the done-step of a feature, before committing.
---

# Sync docs after a feature

Updating docs is part of a slice's done-criterion. This skill names the exact surfaces so
nothing is missed and the commit doesn't fail.

## Files to touch (only the ones the change affects)

- **`README.md`** — the usage tables (new `--flags`), the format list, and the two **Status**
  blurbs (the one-liner near the top and the detailed one near the bottom) that summarize
  what the tool does today.
- **`docs/architecture/collector.md`** — the CLI surface block, the pipeline steps, the
  implemented-adapters list, and the implementation-status paragraph. Keep `[D#]` decision
  links intact.
- **`docs/architecture/decisions.md`** / `overview.md` / `event-schema.md` — only if the
  slice changed a locked decision or the schema. New decisions get a new `D#` entry; don't
  silently alter an existing one's meaning.
- **`CLAUDE.md`** — update the architecture/status prose to match. It is tracked, so stage
  and commit it alongside the other docs.

## Rules

- Keep the doc voice — terse, decision-linked, present-tense "the collector does X".
- Convert any relative date to an absolute one.
- Do NOT put PLAN.md content (strategy/positioning/deadlines) into `docs/` or `CLAUDE.md` —
  PLAN.md stays local-only and uncommitted (`.git/info/exclude`).

## Report back

List which doc files you changed and the one-line gist of each change.
