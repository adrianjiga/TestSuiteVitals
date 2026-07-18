import type { WorkflowRun } from "../github/runs.js";

/**
 * Collect-time run filter (policy, not availability): which listed runs are collected at all.
 * Excluded runs are *deliberately* skipped, so — unlike pending runs — the watermark is allowed
 * to pass them; otherwise a repo whose only recent activity is an excluded workflow would
 * re-list the same window forever.
 */
export interface RunFilter {
  /** Only collect runs of workflows whose name matches this glob (`*` wildcard). */
  workflow?: string | undefined;
  /** Skip runs fired by these trigger events (e.g. `pull_request` to ignore fork PRs). */
  excludeTriggers?: string[] | undefined;
}

export interface FilteredRuns {
  included: WorkflowRun[];
  /** Runs excluded by policy — never collected, and safe for the watermark to pass. */
  excluded: WorkflowRun[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive glob match where `*` matches any span; every other character is literal. */
export function matchesGlob(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
  return regex.test(value);
}

/** Partitions listed runs by the filter. An empty filter includes everything. */
export function filterRuns(runs: WorkflowRun[], filter: RunFilter): FilteredRuns {
  const excludeTriggers = new Set(filter.excludeTriggers ?? []);
  const included: WorkflowRun[] = [];
  const excluded: WorkflowRun[] = [];
  for (const run of runs) {
    const workflowOk = filter.workflow === undefined || matchesGlob(filter.workflow, run.workflow);
    const triggerOk = !excludeTriggers.has(run.trigger);
    (workflowOk && triggerOk ? included : excluded).push(run);
  }
  return { included, excluded };
}
