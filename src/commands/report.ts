import { defineCommand } from "citty";
import { parseRepoRef, repoSlug } from "../github/repo.js";
import { Aggregator } from "../report/aggregate.js";
import { parseSince, rankTests } from "../report/rank.js";
import { readRepoEvents } from "../report/read.js";
import { type ReportMeta, renderReport, renderReportJson } from "../report/render.js";
import { DEFAULT_MIN_RUNS } from "../report/score.js";

const DEFAULT_DATA_DIR = "data";
const DEFAULT_LIMIT = 20;

export const reportCommand = defineCommand({
  meta: {
    name: "report",
    description: "Rank a repo's tests by flakiness from collected events",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to report on, as owner/name",
      required: true,
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
    limit: {
      type: "string",
      description: `Show at most this many ranked tests (default ${DEFAULT_LIMIT})`,
    },
    all: {
      type: "boolean",
      description: "Also show tests below the min-runs threshold",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Emit JSON instead of the table",
      default: false,
    },
  },
  async run({ args }) {
    const slug = repoSlug(parseRepoRef(args.repo));
    const minRuns = parsePositiveInt(args["min-runs"], "--min-runs") ?? DEFAULT_MIN_RUNS;
    const limit = parsePositiveInt(args.limit, "--limit") ?? DEFAULT_LIMIT;
    const since = parseSince(args.since);

    const aggregator = new Aggregator({ byMatrix: args["by-matrix"] });
    for await (const event of readRepoEvents(args["data-dir"], slug)) {
      if (since && new Date(event.run.started_at) < since) {
        continue;
      }
      aggregator.add(event);
    }
    const aggregates = aggregator.results();

    if (aggregates.length === 0) {
      console.log(
        `No events for ${slug}. Run \`suitevitals collect --repo ${slug}\` first` +
          (since ? ", or widen --since." : "."),
      );
      return;
    }

    const ranked = rankTests(aggregates, { minRuns });

    if (args.json) {
      console.log(renderReportJson(ranked));
      return;
    }

    const meta: ReportMeta = {
      slug,
      totalTests: aggregates.length,
      ...(args.since ? { windowLabel: `last ${args.since}` } : {}),
    };
    console.log(renderReport(ranked, meta, { limit, all: args.all }));
  },
});

/** Parses a positive-integer flag; returns undefined when absent so the default applies. */
function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${flag} "${value}": expected a positive integer.`);
  }
  return n;
}
