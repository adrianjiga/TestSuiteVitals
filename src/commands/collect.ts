import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  type ArtifactFetcher,
  type ArtifactFetchSummary,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ARTIFACT_MB,
  fetchReportArtifacts,
} from "../artifacts/fetch.js";
import { type CollectTarget, loadConfig, resolveTargets } from "../collect/config.js";
import { type ParseSummary, parseRunReports } from "../collect/parse.js";
import { nextWatermark } from "../collect/watermark.js";
import { computeWindow, DEFAULT_BACKFILL_HOURS } from "../collect/window.js";
import { colorSupported, createPalette, type Palette } from "../colors.js";
import { downloadArtifactZip, listRunArtifacts } from "../github/artifacts.js";
import { AuthError } from "../github/auth.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import type { RepoRef } from "../github/repo.js";
import { classifyRuns, listRunsSince } from "../github/runs.js";
import { acquireLock, LockError } from "../state/lock.js";
import { loadState, repoState, type State, saveState } from "../state/state.js";
import { type AppendResult, appendEvents } from "../store/ndjson.js";
import { parseRepoFlags } from "./repo-flags.js";

const DEFAULT_STATE_PATH = "state.json";
const DEFAULT_DATA_DIR = "data";

/** Options shared by every repo in a single `collect` invocation. */
interface SharedOptions {
  stateFile: string;
  dataDir: string;
  dryRun: boolean;
  fullErrors: boolean;
  maxArtifactMb: number | undefined;
  now: Date;
  palette: Palette;
}

/** Running totals folded across all collected repos for the final summary. */
interface RunTotals {
  repos: number;
  eventsBuilt: number;
  written: number;
  deduped: number;
}

export const collectCommand = defineCommand({
  meta: {
    name: "collect",
    description: "Collect test-report artifacts from GitHub Actions runs",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to collect from, as owner/name (repeatable)",
    },
    config: {
      type: "string",
      description: "Path to a JSON config file listing repos and per-repo overrides",
    },
    token: {
      type: "string",
      description: "GitHub token (overrides GITHUB_TOKEN and the gh CLI)",
    },
    "hours-back": {
      type: "string",
      description: "Backfill window in hours; overrides the stored watermark",
    },
    "state-file": {
      type: "string",
      description: "Path to the state file",
      default: DEFAULT_STATE_PATH,
    },
    "data-dir": {
      type: "string",
      description: "Directory for the NDJSON event partitions",
      default: DEFAULT_DATA_DIR,
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would be fetched without writing any data",
      default: false,
    },
    "full-errors": {
      type: "boolean",
      description: "Store full error messages without redaction or truncation",
      default: false,
    },
    concurrency: {
      type: "string",
      description: `Number of runs to fetch in parallel (default ${DEFAULT_CONCURRENCY})`,
    },
    "max-artifact-mb": {
      type: "string",
      description: `Size cap for sniffing unnamed report artifacts (default ${DEFAULT_MAX_ARTIFACT_MB})`,
    },
  },
  async run({ args, rawArgs }) {
    const hoursBack = parseHoursBack(args["hours-back"]);
    const concurrency = parseConcurrency(args.concurrency);
    const maxArtifactMb = parseMaxArtifactMb(args["max-artifact-mb"]);
    const palette = createPalette(colorSupported);

    const config = args.config ? await loadConfig(args.config) : undefined;
    const targets = resolveTargets({
      cliRepos: parseRepoFlags(rawArgs),
      cliHoursBack: hoursBack,
      cliConcurrency: concurrency,
      config,
      defaultConcurrency: DEFAULT_CONCURRENCY,
    });

    const client = await authenticate(args.token, palette);
    if (!client) {
      return;
    }

    // Single-writer guard (F5): overlapping collects on the same state file would race the
    // read-keys → append sequence into duplicates and clobber each other's watermarks.
    let releaseLock: () => Promise<void>;
    try {
      releaseLock = await acquireLock(`${args["state-file"]}.lock`);
    } catch (error) {
      if (error instanceof LockError) {
        console.error(palette.bad(error.message));
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    try {
      const now = new Date();
      const state = await loadState(args["state-file"]);
      const shared: SharedOptions = {
        stateFile: args["state-file"],
        dataDir: args["data-dir"],
        dryRun: args["dry-run"],
        fullErrors: args["full-errors"],
        maxArtifactMb,
        now,
        palette,
      };

      if (targets.length > 1) {
        console.log(palette.heading(`Collecting ${targets.length} repositories.`));
      }

      const totals: RunTotals = { repos: 0, eventsBuilt: 0, written: 0, deduped: 0 };
      for (const target of targets) {
        const repoTotals = await collectRepo(client, target, shared, state);
        totals.repos++;
        totals.eventsBuilt += repoTotals.eventsBuilt;
        totals.written += repoTotals.written;
        totals.deduped += repoTotals.deduped;
      }

      if (targets.length > 1) {
        printRunSummary(totals, shared.dryRun, palette);
      }
    } finally {
      await releaseLock();
    }
  },
});

/**
 * Collects a single repo end-to-end: window → list/classify → fetch → parse → durable append →
 * advance watermark and save state (D12: append first, then state). State is saved per repo so a
 * crash partway through a multi-repo run keeps the repos already collected. Returns the repo's
 * totals for the combined summary.
 */
async function collectRepo(
  client: GitHubClient,
  target: CollectTarget,
  shared: SharedOptions,
  state: State,
): Promise<RunTotals> {
  const { octokit } = client;
  const { ref, slug } = target;
  const p = shared.palette;
  const previous = repoState(state, slug);
  const window = computeWindow(previous, { hoursBack: target.hoursBack, now: shared.now });

  console.log(
    `\n${p.repo(`[${slug}]`)} Listing runs since ${p.dim(window.since.toISOString())} (${window.source}).`,
  );
  if (window.source === "default") {
    console.log(
      p.dim(
        `  First run: defaulting to the last ${DEFAULT_BACKFILL_HOURS}h. Use --hours-back to go wider.`,
      ),
    );
  }

  const runs = await listRunsSince(octokit, ref, window.since);
  const { completed, pending } = classifyRuns(runs);
  const pendingText = pending.length > 0 ? p.warn(`${pending.length} pending`) : "0 pending";
  console.log(
    p.dim(`  Found ${runs.length} run(s): ${completed.length} completed, `) + pendingText,
  );

  const workdir = await mkdtemp(join(tmpdir(), "suitevitals-"));
  try {
    const { summary, reports } = await fetchReportArtifacts(
      makeArtifactFetcher(octokit, ref),
      completed,
      workdir,
      {
        dryRun: shared.dryRun,
        onProgress: (done, total) => reportProgress(done, total, p),
        concurrency: target.concurrency,
        ...(shared.maxArtifactMb !== undefined ? { maxArtifactMb: shared.maxArtifactMb } : {}),
      },
    );
    printArtifactSummary(summary, shared.dryRun, p);

    if (shared.dryRun) {
      return { repos: 1, eventsBuilt: 0, written: 0, deduped: 0 };
    }

    const parsed = await parseRunReports(reports, slug, {
      fullErrors: shared.fullErrors,
      now: shared.now,
    });
    printParseSummary(parsed.summary, p);

    // Durable append first, then advance state — so a crash in between is recovered by
    // re-collecting (dedup absorbs the overlap), never skipped (D12).
    const append = await appendEvents(shared.dataDir, slug, parsed.events);
    const watermark = nextWatermark(previous.watermark, completed, pending);
    state.repos[slug] = {
      watermark,
      pending_runs: pending.map((run) => run.run_id),
      last_collected_at: shared.now.toISOString(),
    };
    await saveState(shared.stateFile, state);
    printAppendSummary(append, watermark, p);

    return {
      repos: 1,
      eventsBuilt: parsed.summary.eventsBuilt,
      written: append.written,
      deduped: append.deduped,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Builds an {@link ArtifactFetcher} bound to one repo's Octokit client. */
function makeArtifactFetcher(octokit: GitHubClient["octokit"], ref: RepoRef): ArtifactFetcher {
  return {
    list: (runId) => listRunArtifacts(octokit, ref, runId),
    download: (artifactId) => downloadArtifactZip(octokit, ref, artifactId),
  };
}

/**
 * Live progress for the fetch pool. On a TTY it rewrites a single line; on a non-TTY (CI,
 * redirected output) it prints periodic milestones instead of spamming.
 */
function reportProgress(done: number, total: number, palette: Palette): void {
  const line = palette.dim(`  Fetching artifacts: ${done}/${total} run(s)…`);
  if (process.stderr.isTTY) {
    process.stderr.write(`\r${line}`);
    if (done === total) {
      process.stderr.write("\n");
    }
  } else if (done === total || done === 1 || done % 10 === 0) {
    process.stderr.write(`${line}\n`);
  }
}

function printArtifactSummary(summary: ArtifactFetchSummary, dryRun: boolean, p: Palette): void {
  const verb = dryRun ? "Would download" : "Downloaded";
  console.log(
    p.dim(
      `  Artifacts: scanned ${summary.runsScanned} run(s), saw ${summary.artifactsSeen} artifact(s).`,
    ),
  );
  console.log(
    p.dim(
      `    ${verb} ${summary.reportArtifacts} report artifact(s)` +
        (dryRun ? "." : `, extracted ${summary.filesExtracted} file(s).`),
    ),
  );
  if (summary.sniffedArtifacts > 0) {
    const verb2 = dryRun ? "would sniff" : "sniffed";
    console.log(
      p.dim(`    ${verb2} ${summary.sniffedArtifacts} unnamed artifact(s) for reports (tier 3).`),
    );
  }
  if (summary.expiredArtifacts > 0) {
    console.log(
      p.warn(
        `    ${summary.expiredArtifacts} expired artifact(s) across ${summary.runsWithExpired} run(s) (retention elapsed).`,
      ),
    );
  }
  if (summary.oversizedArtifacts > 0) {
    console.log(
      p.warn(
        `    ${summary.oversizedArtifacts} artifact(s) skipped as oversized (--max-artifact-mb or the extraction budget).`,
      ),
    );
  }
  if (summary.skippedArtifacts > 0) {
    console.log(p.dim(`    ${summary.skippedArtifacts} non-report artifact(s) skipped.`));
  }
}

function printParseSummary(summary: ParseSummary, p: Palette): void {
  console.log(
    p.dim(`  Reports: parsed ${summary.filesParsed}/${summary.filesScanned} candidate file(s).`),
  );
  const passed = p.good(`${summary.passed} passed`);
  const failed = summary.failed > 0 ? p.bad(`${summary.failed} failed`) : p.dim("0 failed");
  const skipped = summary.skipped > 0 ? p.warn(`${summary.skipped} skipped`) : p.dim("0 skipped");
  console.log(`    ${summary.eventsBuilt} test event(s): ${passed}, ${failed}, ${skipped}.`);
}

function printAppendSummary(append: AppendResult, watermark: string | undefined, p: Palette): void {
  const wrote =
    append.written > 0
      ? p.good(`wrote ${append.written} new event(s)`)
      : p.dim("wrote 0 new event(s)");
  console.log(
    `  Stored: ${wrote}, ${p.dim(`${append.deduped} duplicate(s) skipped across ${append.partitions} partition(s).`)}`,
  );
  console.log(p.dim(`    Watermark advanced to ${watermark ?? "(unset)"}.`));
}

function printRunSummary(totals: RunTotals, dryRun: boolean, p: Palette): void {
  if (dryRun) {
    console.log(p.heading(`\nDone (dry run): scanned ${totals.repos} repositories.`));
    return;
  }
  console.log(
    p.heading(
      `\nDone: ${totals.repos} repositories, wrote ${totals.written} new event(s), ${totals.deduped} duplicate(s) skipped.`,
    ),
  );
}

/**
 * Resolves the GitHub client, printing the token source on success. On an auth failure it
 * reports the error, sets a non-zero exit code, and returns null so the caller can stop
 * cleanly. Other errors propagate.
 */
async function authenticate(
  token: string | undefined,
  palette: Palette,
): Promise<GitHubClient | null> {
  try {
    const client = await createGitHubClient({ token });
    console.log(palette.dim(`Authenticated with GitHub (token source: ${client.tokenSource}).`));
    return client;
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(palette.bad(error.message));
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}

/** Parses and validates `--hours-back`; returns undefined when not provided. */
function parseHoursBack(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`Invalid --hours-back "${value}": expected a positive number.`);
  }
  return hours;
}

/** Parses and validates `--concurrency`; returns undefined to use the default. */
function parseConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --concurrency "${value}": expected a positive integer.`);
  }
  return n;
}

/** Parses and validates `--max-artifact-mb`; returns undefined to use the default. */
function parseMaxArtifactMb(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --max-artifact-mb "${value}": expected a positive number.`);
  }
  return n;
}
