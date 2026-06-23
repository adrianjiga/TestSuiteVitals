import { defineCommand } from "citty";
import { AuthError } from "../github/auth.js";
import { createGitHubClient } from "../github/client.js";

export const collectCommand = defineCommand({
  meta: {
    name: "collect",
    description: "Collect test-report artifacts from GitHub Actions runs",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to collect from, as owner/name",
    },
    token: {
      type: "string",
      description: "GitHub token (overrides GITHUB_TOKEN and the gh CLI)",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would be fetched without writing any data",
      default: false,
    },
  },
  async run({ args }) {
    try {
      const { tokenSource } = await createGitHubClient({ token: args.token });
      console.log(`Authenticated with GitHub (token source: ${tokenSource}).`);
    } catch (error) {
      if (error instanceof AuthError) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    // M1 (in progress): list runs since watermark, fetch tier-1 artifacts,
    // dispatch the JUnit adapter, append NDJSON events with dedup, summarize.
    console.log("collect: run listing not yet implemented (M1 in progress).");
  },
});
