import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  type ArtifactFetcher,
  type ArtifactFetchSummary,
  DEFAULT_CONCURRENCY,
  fetchReportArtifacts,
} from "../artifacts/fetch.js";
import { type CollectTarget, loadConfig, resolveTargets } from "../collect/config.js";
import { type ParseSummary, parseRunReports } from "../collect/parse.js";
import { nextWatermark } from "../collect/watermark.js";
import { computeWindow, DEFAULT_BACKFILL_HOURS } from "../collect/window.js";
import { downloadArtifactZip, listRunArtifacts } from "../github/artifacts.js";
import { AuthError } from "../github/auth.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import type { RepoRef } from "../github/repo.js";
import { classifyRuns, listRunsSince } from "../github/runs.js";
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
  now: Date;
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
  },
  async run({ args, rawArgs }) {
    const hoursBack = parseHoursBack(args["hours-back"]);
    const concurrency = parseConcurrency(args.concurrency);

    const config = args.config ? await loadConfig(args.config) : undefined;
    const targets = resolveTargets({
      cliRepos: parseRepoFlags(rawArgs),
      cliHoursBack: hoursBack,
      cliConcurrency: concurrency,
      config,
      defaultConcurrency: DEFAULT_CONCURRENCY,
    });

    const client = await authenticate(args.token);
    if (!client) {
      return;
    }

    const now = new Date();
    const state = await loadState(args["state-file"]);
    const shared: SharedOptions = {
      stateFile: args["state-file"],
      dataDir: args["data-dir"],
      dryRun: args["dry-run"],
      fullErrors: args["full-errors"],
      now,
    };

    if (targets.length > 1) {
      console.log(`Collecting ${targets.length} repositories.`);
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
      printRunSummary(totals, shared.dryRun);
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
  const previous = repoState(state, slug);
  const window = computeWindow(previous, { hoursBack: target.hoursBack, now: shared.now });

  console.log(`\n[${slug}] Listing runs since ${window.since.toISOString()} (${window.source}).`);
  if (window.source === "default") {
    console.log(
      `  First run: defaulting to the last ${DEFAULT_BACKFILL_HOURS}h. Use --hours-back to go wider.`,
    );
  }

  const runs = await listRunsSince(octokit, ref, window.since);
  const { completed, pending } = classifyRuns(runs);
  console.log(
    `  Found ${runs.length} run(s): ${completed.length} completed, ${pending.length} pending.`,
  );

  const workdir = await mkdtemp(join(tmpdir(), "suitevitals-"));
  try {
    const { summary, reports } = await fetchReportArtifacts(
      makeArtifactFetcher(octokit, ref),
      completed,
      workdir,
      { dryRun: shared.dryRun, onProgress: reportProgress, concurrency: target.concurrency },
    );
    printArtifactSummary(summary, shared.dryRun);

    if (shared.dryRun) {
      return { repos: 1, eventsBuilt: 0, written: 0, deduped: 0 };
    }

    const parsed = await parseRunReports(reports, slug, {
      fullErrors: shared.fullErrors,
      now: shared.now,
    });
    printParseSummary(parsed.summary);

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
    printAppendSummary(append, watermark);

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
function reportProgress(done: number, total: number): void {
  const line = `  Fetching artifacts: ${done}/${total} run(s)…`;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r${line}`);
    if (done === total) {
      process.stderr.write("\n");
    }
  } else if (done === total || done === 1 || done % 10 === 0) {
    process.stderr.write(`${line}\n`);
  }
}

function printArtifactSummary(summary: ArtifactFetchSummary, dryRun: boolean): void {
  const verb = dryRun ? "Would download" : "Downloaded";
  console.log(
    `  Artifacts: scanned ${summary.runsScanned} run(s), saw ${summary.artifactsSeen} artifact(s).`,
  );
  console.log(
    `    ${verb} ${summary.reportArtifacts} report artifact(s)` +
      (dryRun ? "." : `, extracted ${summary.filesExtracted} file(s).`),
  );
  if (summary.expiredArtifacts > 0) {
    console.log(
      `    ${summary.expiredArtifacts} expired artifact(s) across ${summary.runsWithExpired} run(s) (retention elapsed).`,
    );
  }
  if (summary.skippedArtifacts > 0) {
    console.log(`    ${summary.skippedArtifacts} non-report artifact(s) skipped.`);
  }
}

function printParseSummary(summary: ParseSummary): void {
  console.log(
    `  Reports: parsed ${summary.filesParsed}/${summary.filesScanned} candidate file(s).`,
  );
  console.log(
    `    ${summary.eventsBuilt} test event(s): ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`,
  );
}

function printAppendSummary(append: AppendResult, watermark: string | undefined): void {
  console.log(
    `  Stored: wrote ${append.written} new event(s), ${append.deduped} duplicate(s) skipped across ${append.partitions} partition(s).`,
  );
  console.log(`    Watermark advanced to ${watermark ?? "(unset)"}.`);
}

function printRunSummary(totals: RunTotals, dryRun: boolean): void {
  if (dryRun) {
    console.log(`\nDone (dry run): scanned ${totals.repos} repositories.`);
    return;
  }
  console.log(
    `\nDone: ${totals.repos} repositories, wrote ${totals.written} new event(s), ${totals.deduped} duplicate(s) skipped.`,
  );
}

/**
 * Resolves the GitHub client, printing the token source on success. On an auth failure it
 * reports the error, sets a non-zero exit code, and returns null so the caller can stop
 * cleanly. Other errors propagate.
 */
async function authenticate(token: string | undefined): Promise<GitHubClient | null> {
  try {
    const client = await createGitHubClient({ token });
    console.log(`Authenticated with GitHub (token source: ${client.tokenSource}).`);
    return client;
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(error.message);
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
