# Troubleshooting

Each section starts from what you see, explains the cause, and gives the fix.
Two commands narrow most problems down: `suitevitals doctor --repo <owner/name>`
shows whether a repo uploads reports at all, and `collect --dry-run` shows
which runs and artifacts would be fetched without downloading or writing
anything.

A failing command prints a single `Error: <message>` line. Set
`SUITEVITALS_DEBUG=1` to print the full error with its stack trace instead:

```bash
SUITEVITALS_DEBUG=1 suitevitals report --repo acme/shop
```

Inside a multi-repo `collect`, a repo's failure is printed as
`[owner/name] collect failed: <message>` without a stack, even with
`SUITEVITALS_DEBUG`; run that repo alone to see more.

## "No GitHub token found"

```text
No GitHub token found. Provide one of:
  • --token <token>
  • GITHUB_TOKEN environment variable
  • authenticate the GitHub CLI: `gh auth login`
```

`collect` and `doctor` need a token and found none. They try `--token`, then
`GITHUB_TOKEN`, then `gh auth token`. An empty or whitespace-only value counts
as missing, and `gh` counts only when it is installed, on `PATH` and signed in.

Fix: pass `--token`, export `GITHUB_TOKEN`, or run `gh auth login`. The first
line of a successful run names the source used
(`token source: flag`, `env` or `gh-cli`).

If a token is found but GitHub answers 401, 403 or 404, check its access: a
fine-grained token needs **Actions: read** and **Contents: read** on that repo;
a classic token needs the `repo` scope for private repos. The Actions-provided
`GITHUB_TOKEN` only reaches the repo its workflow runs in, and needs
`actions: read` and `contents: read` in the workflow's `permissions:` (`doctor`
reads file contents).

## "Another suitevitals process appears to be running"

```text
Error: Another suitevitals process appears to be running (lock state.json.lock held by pid 48213). If that process is gone, delete the lock file and retry.
```

`collect` holds `<state-file>.lock`, and `collect`, `compact` and `prune` hold
`<data-dir>/.lock`, so two of them cannot write the same files at once.

- **Another run is still going.** A scheduled job overlapping a manual run is
  the usual case. Wait for it, or give each its own `--state-file` and
  `--data-dir`.
- **The holder died.** A lock whose pid is no longer running is removed
  automatically, with `Breaking stale lock <path>: holder <pid> is gone.` You
  only see the error when the pid is alive: either the run is real, or the
  machine rebooted and an unrelated process now has that pid, or the lock is
  on a disk shared with another machine. Check with `ps -p <pid>`; if it is not
  suitevitals, delete the lock file named in the message and run again.

Ctrl-C releases the locks before exiting. Rerunning an interrupted `collect` is
safe: nothing is skipped and nothing is stored twice.

## "No collected events for …"

```text
Error: No collected events for acme/shop in /home/me/ci/data/acme__shop. Run `suitevitals collect --repo acme/shop` first, or point --data-dir at the collected data.
```

`report` and `dashboard` found no partition files for the repo. The message
shows the absolute directory they looked in.

- **Different working directory.** `--data-dir` defaults to `./data`, relative
  to where you run the command. Run from the directory you collected in, or
  pass the same `--data-dir` to every command.
- **Different spelling.** The directory is `<owner>__<repo>` exactly as you
  typed it. On a case-sensitive file system `--repo Acme/Shop` and
  `--repo acme/shop` are different directories; use the same case each time.
- **Nothing collected yet.** See the next section.

If events exist but none match `--since`, `--branch` or `--workflow`, the
message is instead `No events for <repo> match <filters>; loosen
--since/--branch/--workflow.` and the exit code is 0.

## `report` shows nothing after `collect`

Look at the `collect` output for the repo.

- **`Found 0 run(s)`.** The window had no runs. A repo's first collect covers
  only the last 72 hours; use `--hours-back 720` (30 days) or more to backfill.
- **`saw 0 artifact(s)`, or only `non-report artifact(s) skipped`.** The
  workflow uploads no test reports. Run `doctor`: it detects the framework and
  prints the reporter and `actions/upload-artifact` step to add. Use
  `if: always()` on the upload step, or failing runs, the ones that matter,
  upload nothing.
- **`expired artifact(s) … (retention elapsed)`.** GitHub deleted the artifacts
  (90 days by default, often less). They cannot be recovered; collect on a
  schedule shorter than the retention period.
- **`excluded by filters`.** `--workflow` or `--exclude-trigger` (or the same
  keys in `--config`) dropped the runs. `--workflow` matches the workflow's
  _name_ (`name:` in the YAML, such as `Playwright Tests`), not its file name;
  `*` is the only wildcard. An empty `--workflow ""` (say, from an unset shell
  variable) is rejected rather than treated as matching nothing.
- **`Reports: parsed 0/<n> candidate file(s)`.** Files were downloaded but none
  is a supported format. Only JUnit XML, Playwright blob reports and
  Mochawesome JSON are read, from `.xml`, `.jsonl` and `.json` files. An HTML
  report alone is not enough.
- **`<n> pending`.** Runs still in progress are collected on a later collect.

## Every test is "below the min-runs threshold"

`report` prints `No flaky tests above the min-runs threshold.` and
`<n> test(s) below the min-runs threshold hidden (--all to show).`

A test is ranked only after `--min-runs` (default 5) runs that passed or
failed; skips do not count. Collect more history with a larger `--hours-back`,
pass `--all` to see the small samples, or lower `--min-runs` and treat the
scores with care.

## Artifacts are skipped as oversized

```text
    2 artifact(s) skipped as oversized (--max-artifact-mb or the extraction budget).
```

Three limits produce this line:

- **The sniff cap, `--max-artifact-mb` (default 100).** When a run has no
  artifact with `report`, `result`, `junit`, `blob` or `mochawesome` in its
  name, its other artifacts are downloaded to look for reports, but only those
  under this size. Rename the report artifact so it matches, or raise the cap.
- **The extraction budget (500 MB).** An archive whose contents add up to more
  than 500 MB uncompressed is not extracted. This protects against zip bombs
  and is not configurable.
- **A report artifact larger than 500 MB compressed** is skipped before
  download for the same reason.

Large report artifacts are almost always videos, traces and screenshots
uploaded with the report. Upload the machine-readable report (`junit.xml`,
`blob-report/`, `mochawesome.json`) as its own artifact, and the media
separately under a name without those words.

## A test's history is split into two rows

A test's identity is a hash of its file path and its title path. Anything that
changes either starts a new history:

- **Renamed file, suite or test.** Expected: old runs stay under the old name.
- **Different paths for the same file.** Paths are normalized: `\` becomes `/`
  and the GitHub Actions workspace prefix (`/home/runner/work/<repo>/<repo>/`,
  macOS and Windows runners, self-hosted `…/_work/…`, containers `/__w/…`) is
  removed. A reporter that writes absolute paths from somewhere else, or
  relative paths from different working directories, still produces two ids.
  Configure the reporter to write paths relative to the repo root.

Matrix cells do not split a test by default: `report` puts every cell of a test
in one row. With `--by-matrix`, each cell gets its own row, and the cell comes
from the artifact name. If artifact names carry something that changes every
run (a run number, a date), every run becomes its own cell. Use
`--matrix-from-artifact` with named groups for the parts that matter:

```bash
suitevitals collect --repo acme/shop \
  --matrix-from-artifact 'results-(?<browser>chrome|firefox)-(?<shard>\d+)'
```

The new pattern applies to runs collected from then on. Re-collecting runs that
are already stored, with a different pattern, stores them a second time under
the new cells.

## The same results are counted twice

If the workflow uploads per-cell reports _and_ a merged report of the same
results, both are collected and every test is counted once per cell and once
more under the merged artifact. Skip the merged one by name:

```bash
suitevitals collect --repo acme/shop --exclude-artifact 'final-test-report'
```

## A re-run was not collected

A run re-run ("Re-run failed jobs") keeps its run id and gets a new attempt.

- **Re-run of a recent run.** Runs created within the last
  `--rerun-lookback-hours` (default 48) are listed again on every collect, so a
  new attempt is found. The output shows
  `Found <n> re-run(s) of older run(s) to collect.`
- **Re-run of an older run.** Raise the lookback for one collect, for example
  `--rerun-lookback-hours 336` (14 days), or widen the window with
  `--hours-back`. Re-collecting the original attempt stores nothing new.
- **Lookback disabled.** `--rerun-lookback-hours 0` turns this off.

## "Invalid --since"

```text
Error: Invalid --since "1 month": expected an ISO timestamp or a span like 30d or 12h.
```

`--since` takes a whole number of days or hours (`30d`, `12h`), or a date or
timestamp (`2026-10-01`, `2026-10-01T00:00:00Z`). Weeks, months and spaces are
not accepted. The other numeric flags fail the same way, for example
`Invalid --min-runs "0": expected a positive integer.`

## `collect` is slow or hits rate limits

```text
GitHub rate limit hit on GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}; waiting 60s before retry 1/3.
```

suitevitals waits and retries on rate limits (three times per request) and on
transient errors, so these warnings alone are not failures. A long first
backfill of a busy repo is mostly artifact downloads.

- Lower `--concurrency` (default 5) to make fewer requests at once, which
  avoids GitHub's secondary rate limits.
- Cap each collect with `--max-runs <n>`. The oldest runs are processed first,
  the watermark advances only past them, and the next collect continues where
  this one stopped.
- `--exclude-trigger pull_request` or `--workflow` skip runs you do not need
  before anything is downloaded.

## Skipping a long gap in collection

If a repo has not been collected for a long time, the next collect starts at
the stored watermark and fetches everything since. To start fresh instead,
delete the repo's entry under `repos` in `state.json` (while no collect is
running). The next collect treats it as a first run: the last 72 hours, or
`--hours-back`. Existing events stay, and anything collected again is not
stored twice.

## `state.json` cannot be read

`collect` fails with a JSON parse error such as `Error: Expected property name
or '}' in JSON at position 1`. The message does not name the file. The state
file was edited by hand or damaged. It is written through a
temporary file and a rename, so `collect` itself does not leave it
half-written. Fix the JSON, or remove the broken repo entry. Deleting the file
re-collects every repo's first-run window; nothing is stored twice.

## Warnings about skipped files or lines

These cost one file or line and never stop a collect or report:

- `Skipping unparseable report file <path>: <reason>`: a report that looked
  like a supported format but could not be parsed, such as a truncated upload.
- `Skipping artifact "<name>" (#<id>) of run <id>: <reason>`: a corrupt
  archive, or one with entries that would escape the extraction folder.
- `Skipping malformed line in <file> (corrupt partition?).`: a damaged line in
  the data directory, usually from a hand edit. `compact` keeps such lines as
  they are.

## Config file errors

`collect --config` checks the whole file before any network call:

- `Invalid config <path>: not valid JSON (…)` or `expected a JSON object.`
- `Invalid config <path>: "repos" must be an array.`
- `Invalid config <path> repos[2]: expected "owner/name" or an object with "repo".`
- `Invalid config <path> repos[0] matrixFromArtifact: the pattern must declare
  at least one named group, …`

A `--matrix-from-artifact` pattern given on the command line is checked the same
way, also before any network call (`Invalid --matrix-from-artifact: …`).

Values from a repo's entry override CLI flags, which override top-level config
values. A flag that seems to be ignored is usually overridden by that repo's
entry. See [API-Interface-Design.md](API-Interface-Design.md#configuration-file).

## `npm install` reports vulnerabilities in `picomatch`

The advisory comes from `picomatch`, which reaches this repository only through
`vitest` and its `vite` and `tinyglobby` dependencies. These are development
dependencies used to run the test suite; none of them ship in the published
package. suitevitals' own glob matching (`--workflow`, `--exclude-artifact`)
does not use `picomatch`.

The production dependency tree is clean: `npm audit --omit=dev` reports no
vulnerabilities, and CI runs that check (at `--audit-level=high`) on every
build and before publishing. The development warning
goes away when `vitest` updates the dependency.
