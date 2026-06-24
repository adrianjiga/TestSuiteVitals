import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  type ArtifactFetcher,
  type ArtifactFetchSummary,
  fetchReportArtifacts,
} from "../artifacts/fetch.js";
import { type ParseSummary, parseRunReports } from "../collect/parse.js";
import { computeWindow, DEFAULT_BACKFILL_HOURS } from "../collect/window.js";
import { downloadArtifactZip, listRunArtifacts } from "../github/artifacts.js";
import { AuthError } from "../github/auth.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import { parseRepoRef, type RepoRef, repoSlug } from "../github/repo.js";
import { classifyRuns, listRunsSince } from "../github/runs.js";
import { loadState, repoState } from "../state/state.js";

const DEFAULT_STATE_PATH = "state.json";

export const collectCommand = defineCommand({
  meta: {
    name: "collect",
    description: "Collect test-report artifacts from GitHub Actions runs",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to collect from, as owner/name",
      required: true,
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
  },
  async run({ args }) {
    const ref = parseRepoRef(args.repo);
    const slug = repoSlug(ref);

    const hoursBack = parseHoursBack(args["hours-back"]);

    const client = await authenticate(args.token);
    if (!client) {
      return;
    }
    const { octokit } = client;

    const state = await loadState(args["state-file"]);
    const window = computeWindow(repoState(state, slug), { hoursBack });

    console.log(`Listing runs for ${slug} since ${window.since.toISOString()} (${window.source}).`);
    if (window.source === "default") {
      console.log(
        `  First run: defaulting to the last ${DEFAULT_BACKFILL_HOURS}h. Use --hours-back to go wider.`,
      );
    }

    const runs = await listRunsSince(octokit, ref, window.since);
    const { completed, pending } = classifyRuns(runs);

    console.log(
      `Found ${runs.length} run(s): ${completed.length} completed, ${pending.length} pending.`,
    );

    const dryRun = args["dry-run"];
    const workdir = await mkdtemp(join(tmpdir(), "suitevitals-"));
    try {
      const { summary, reports } = await fetchReportArtifacts(
        makeArtifactFetcher(octokit, ref),
        completed,
        workdir,
        { dryRun },
      );
      printArtifactSummary(summary, dryRun);

      if (!dryRun) {
        const parsed = await parseRunReports(reports, slug, {
          fullErrors: args["full-errors"],
        });
        printParseSummary(parsed.summary);
      }
    } finally {
      // Events aren't persisted yet; the NDJSON-append slice will. Clean up.
      await rm(workdir, { recursive: true, force: true });
    }

    // M1 (next): append the parsed events to NDJSON with dedup, then advance the
    // watermark (D12).
  },
});

/** Builds an {@link ArtifactFetcher} bound to one repo's Octokit client. */
function makeArtifactFetcher(octokit: GitHubClient["octokit"], ref: RepoRef): ArtifactFetcher {
  return {
    list: (runId) => listRunArtifacts(octokit, ref, runId),
    download: (artifactId) => downloadArtifactZip(octokit, ref, artifactId),
  };
}

function printArtifactSummary(summary: ArtifactFetchSummary, dryRun: boolean): void {
  const verb = dryRun ? "Would download" : "Downloaded";
  console.log(
    `Artifacts: scanned ${summary.runsScanned} run(s), saw ${summary.artifactsSeen} artifact(s).`,
  );
  console.log(
    `  ${verb} ${summary.reportArtifacts} report artifact(s)` +
      (dryRun ? "." : `, extracted ${summary.filesExtracted} file(s).`),
  );
  if (summary.expiredArtifacts > 0) {
    console.log(
      `  ${summary.expiredArtifacts} expired artifact(s) across ${summary.runsWithExpired} run(s) (retention elapsed).`,
    );
  }
  if (summary.skippedArtifacts > 0) {
    console.log(`  ${summary.skippedArtifacts} non-report artifact(s) skipped.`);
  }
}

function printParseSummary(summary: ParseSummary): void {
  console.log(`Reports: parsed ${summary.filesParsed}/${summary.filesScanned} candidate file(s).`);
  console.log(
    `  ${summary.eventsBuilt} test event(s): ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`,
  );
}

/**
 * Resolves the GitHub client, printing the token source on success. On an auth
 * failure it reports the error, sets a non-zero exit code, and returns null so
 * the caller can stop cleanly. Other errors propagate.
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
