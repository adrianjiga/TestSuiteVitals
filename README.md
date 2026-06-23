# Suitevitals

> The vital signs of your test suite.

A CLI-first, zero-infrastructure tool that retroactively ingests the CI artifacts
you already upload and tells you which tests are flaky, how badly, and where.
No server, no instrumentation changes — point it at a GitHub repo, and it
normalizes the test-report artifacts into plain files you own.

> **Status:** early development (M1 — walking skeleton). Not yet published to npm.

## Requirements

- Node.js >= 24

## Development

```bash
npm install
npm run dev -- collect --help   # run the CLI from source
npm test                        # run the test suite
npm run typecheck               # type-check without emitting
npm run check                   # Biome: lint + format + autofix
npm run lint                    # Biome: lint only
npm run format                  # Biome: format only
npm run build                   # compile to dist/
```

## Authentication

Suitevitals talks to GitHub through a single Octokit transport and resolves a
token in this order:

1. `--token <token>`
2. `GITHUB_TOKEN` environment variable
3. `gh auth token` (the GitHub CLI, if installed and authenticated)

If none yields a token, it exits with a message listing all three options.

## License

MIT © Adrian Jiga
