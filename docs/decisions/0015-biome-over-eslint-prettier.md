# 0015 — Use Biome for linting and formatting

**Status**: Accepted

## Context

A TypeScript CLI needs a linter, a formatter and import ordering. ESLint plus
Prettier means several dev dependencies, several config files and two tools to
keep in step.

## Decision

Biome (`@biomejs/biome`, pinned exactly) owns lint, format and import order,
configured in `biome.json`: recommended rules, double quotes, 2-space indent,
100 columns, `.gitignore` respected. `npm run check` lint-fixes and formats; CI
runs `biome ci`.

- Biome also formats Markdown (padded tables, `_emphasis_`), except under
  `.claude/`, whose agent and skill files carry frontmatter it would rewrite.
- `complexity/useMathMinMax` is off: it flags the ISO-timestamp string
  comparisons in `src/collect/watermark.ts` and `src/collect/filter.ts`, where
  the suggested `Math.max`/`Math.min` would return `NaN`.

## Consequences

- One dev dependency and one config file; style is never hand-formatted.
- Biome bumps can change formatting (2.6 started formatting Markdown) and
  migrate the config schema; land those in the bump's PR.
- A disabled rule needs a concrete reason, recorded here, not a blanket
  suppression.
