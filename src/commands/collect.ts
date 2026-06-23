import { defineCommand } from "citty";
import { computeWindow, DEFAULT_BACKFILL_HOURS } from "../collect/window.js";
import { AuthError } from "../github/auth.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import { parseRepoRef, repoSlug } from "../github/repo.js";
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

    // M1 (next): fetch tier-1 artifacts for completed runs, dispatch the JUnit
    // adapter, append NDJSON events with dedup, then advance the watermark (D12).
    console.log("collect: artifact fetch not yet implemented (M1 in progress).");
  },
});

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
