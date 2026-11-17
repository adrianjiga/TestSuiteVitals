import { defineCommand } from "citty";
import { matchesGlob } from "../collect/filter.js";
import { colorSupported, createPalette } from "../colors.js";
import { parseRepoRef, repoSlug } from "../github/repo.js";
import { Aggregator } from "../report/aggregate.js";
import { parseSince, rankTests } from "../report/rank.js";
import { noEventsError, readRepoEvents } from "../report/read.js";
import { type ReportMeta, renderReport, renderReportJson } from "../report/render.js";
import { DEFAULT_MIN_RUNS } from "../report/score.js";
import { parseRepoFlags } from "./repo-flags.js";

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
    branch: {
      type: "string",
      description: "Only include runs on this branch (exact match, e.g. main)",
    },
    workflow: {
      type: "string",
      description: "Only include runs of workflows matching this glob (`*` wildcard)",
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
  async run({ args, rawArgs }) {
    // report works on one repo at a time; reject extra --repo flags rather than silently
    // using only the last (citty keeps the last value of a repeated string flag).
    const repos = parseRepoFlags(rawArgs);
    if (repos.length > 1) {
      throw new Error(
        `report works on a single repository, but ${repos.length} --repo flags were given. ` +
          "Run it once per repo.",
      );
    }
    const slug = repoSlug(parseRepoRef(repos[0] ?? args.repo));
    const minRuns = parsePositiveInt(args["min-runs"], "--min-runs") ?? DEFAULT_MIN_RUNS;
    const limit = parsePositiveInt(args.limit, "--limit") ?? DEFAULT_LIMIT;
    const since = parseSince(args.since);

    const aggregator = new Aggregator({ byMatrix: args["by-matrix"] });
    let stored = 0;
    for await (const event of readRepoEvents(args["data-dir"], slug)) {
      stored++;
      if (since && new Date(event.run.started_at) < since) {
        continue;
      }
      if (args.branch && event.run.branch !== args.branch) {
        continue;
      }
      if (args.workflow && !matchesGlob(args.workflow, event.run.workflow)) {
        continue;
      }
      aggregator.add(event);
    }
    const aggregates = aggregator.results();

    if (stored === 0) {
      throw noEventsError(args["data-dir"], slug);
    }
    const filterLabel = describeFilters(args.since, args.branch, args.workflow);
    if (aggregates.length === 0) {
      console.log(
        args.json
          ? "[]"
          : `No events for ${slug} match ${filterLabel}; loosen --since/--branch/--workflow.`,
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
      ...(filterLabel ? { windowLabel: filterLabel } : {}),
    };
    const palette = createPalette(colorSupported);
    console.log(renderReport(ranked, meta, { limit, all: args.all }, palette));
  },
});

/** Human label for the active event filters, e.g. `last 30d · branch main`; empty when none. */
export function describeFilters(
  since: string | undefined,
  branch: string | undefined,
  workflow: string | undefined,
): string {
  const parts = [
    ...(since ? [`last ${since}`] : []),
    ...(branch ? [`branch ${branch}`] : []),
    ...(workflow ? [`workflow ${workflow}`] : []),
  ];
  return parts.join(" · ");
}

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
