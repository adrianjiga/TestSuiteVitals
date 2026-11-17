# Security Policy

## Supported versions

Only the latest published release is actively supported with security fixes.

## Reporting a vulnerability

Please report security issues privately using GitHub's private vulnerability reporting on the
[Security tab](https://github.com/adrianjiga/TestSuiteVitals/security): **Security → Report a
vulnerability**. Do not open a public issue for a security problem.

We ask that reporters keep disclosures private until a fix is released, and we aim to acknowledge
reports within 48 hours and ship a patch within 14 days.

## Scope

suitevitals downloads CI artifacts and parses them. Those artifacts can come from runs triggered
by pull requests from forks, so their contents are untrusted. Things worth reporting include:

- a zip archive that writes outside the extraction directory, or that gets past the decompression
  size budget;
- report content (test titles, error messages, artifact names) that runs script in the HTML
  dashboard;
- terminal escape sequences from report content that reach your terminal;
- secrets in error messages that survive redaction into the stored events;
- the GitHub token appearing in terminal output or in any file suitevitals writes.

Out of scope:

- The `--config` file is trusted. It is a file you chose and pointed suitevitals at.
- `--full-errors` stores error messages without redaction or truncation. That is what the flag is
  for.
- Data you collected on purpose from runs you chose to include. `--exclude-trigger pull_request`
  keeps fork pull request artifacts out entirely.
