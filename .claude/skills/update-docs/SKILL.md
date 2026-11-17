---
name: update-docs
description: Sync the docs after finishing a feature slice — update README.md, CHANGELOG.md, the relevant docs/ files and AGENTS.md, touching exactly the right sections. Use as the done-step of a feature, before committing.
---

# Sync docs after a feature

Updating docs is part of a slice's done-criterion. This skill names the exact surfaces so
nothing is missed and the commit doesn't fail.

## Files to touch (only the ones the change affects)

- **`README.md`** — the commands table, the **Supported** list (formats, report types) and the
  **Learn more** links. Detailed flag tables live in `docs/API-Interface-Design.md`, not here.
- **`CHANGELOG.md`** — add a bullet under the `Unreleased` (or upcoming version) section, in
  Keep a Changelog groups (`Added`, `Changed`, `Fixed`, `Removed`).
- **`docs/API-Interface-Design.md`** — the per-command flag tables, exit codes, the config
  file keys and the core data shapes.
- **`docs/Architecture.md`** / **`docs/Technical-Design.md`** — the pipeline stages, data
  flow, file map, and the deeper design of whatever subsystem changed (including
  **Known issues**).
- **`docs/output-reference.md`** — the stored event schema, the data directory layout, the
  `report` table/JSON and the dashboard, when any of them change.
- **`docs/troubleshooting.md`** — a new error message or a new way for things to go wrong.
- **`docs/decisions/`** — a decision with lasting trade-offs gets a new numbered record
  (`000N-slug.md`, Status/Context/Decision/Consequences) and a line in its `README.md`.
  Don't silently change an accepted record's meaning; supersede it with a new one.
- **`AGENTS.md`** — the commands, architecture, gotchas and conventions agents rely on.

## Rules

- Keep the doc voice — plain, present-tense "collect does X", linked to the decision records.
- Convert any relative date to an absolute one.
- Do NOT put PLAN.md content (strategy/positioning/deadlines) into `docs/` or `AGENTS.md` —
  PLAN.md stays local-only and uncommitted (`.git/info/exclude`).

## Report back

List which doc files you changed and the one-line gist of each change.
