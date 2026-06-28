import { writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { colorSupported, createPalette } from "../colors.js";
import { parseRepoRef, repoSlug } from "../github/repo.js";
import { Aggregator } from "../report/aggregate.js";
import { type DashboardMeta, renderDashboard } from "../report/dashboard.js";
import { parseSince, rankTests } from "../report/rank.js";
import { readRepoEvents } from "../report/read.js";
import { DEFAULT_MIN_RUNS } from "../report/score.js";
import { repoDir } from "../store/partition.js";
import { parseRepoFlags } from "./repo-flags.js";

const DEFAULT_DATA_DIR = "data";

export const dashboardCommand = defineCommand({
  meta: {
    name: "dashboard",
    description: "Generate a self-contained HTML flakiness dashboard for a repo",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to report on, as owner/name",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output HTML file (default <owner>__<repo>.html)",
    },
    "data-dir": {
      type: "string",
      description: "Directory holding the NDJSON event partitions",
      default: DEFAULT_DATA_DIR,
    },
    "by-matrix": {
      type: "boolean",
      description: "Rank each (test, matrix cell) separately instead of collapsing cells",
      default: false,
    },
    "min-runs": {
      type: "string",
      description: `Minimum runs for a test to be ranked (default ${DEFAULT_MIN_RUNS})`,
    },
    since: {
      type: "string",
      description: "Only include runs within this window: a span like 30d/12h or an ISO timestamp",
    },
  },
  async run({ args, rawArgs }) {
    const repos = parseRepoFlags(rawArgs);
    if (repos.length > 1) {
      throw new Error(
        `dashboard works on a single repository, but ${repos.length} --repo flags were given. ` +
          "Run it once per repo.",
      );
    }
    const slug = repoSlug(parseRepoRef(repos[0] ?? args.repo));
    const minRuns = parseMinRuns(args["min-runs"]);
    const since = parseSince(args.since);

    const aggregator = new Aggregator({ byMatrix: args["by-matrix"], timeline: true });
    for await (const event of readRepoEvents(args["data-dir"], slug)) {
      if (since && new Date(event.run.started_at) < since) {
        continue;
      }
      aggregator.add(event);
    }
    const aggregates = aggregator.results();

    const palette = createPalette(colorSupported);
    if (aggregates.length === 0) {
      console.log(
        palette.dim(`No events for ${slug}. Run \`suitevitals collect --repo ${slug}\` first.`),
      );
      return;
    }

    const ranked = rankTests(aggregates, { minRuns });
    const meta: DashboardMeta = {
      slug,
      totalTests: aggregates.length,
      generatedAt: new Date().toISOString(),
      ...(args.since ? { windowLabel: `last ${args.since}` } : {}),
    };

    const output = args.output ?? `${repoDir(slug)}.html`;
    await writeFile(output, renderDashboard(ranked, meta), "utf8");
    console.log(
      `${palette.good("Wrote dashboard")} for ${palette.repo(slug)} to ${output} (${aggregates.length} tests).`,
    );
  },
});

/** Parses and validates `--min-runs`; returns the default when absent. */
function parseMinRuns(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MIN_RUNS;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --min-runs "${value}": expected a positive integer.`);
  }
  return n;
}
