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

/**
 * Case-insensitive glob match where `*` matches any span and every other character is literal;
 * spaces around the pattern are ignored.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.trim().split("*").map(escapeRegExp).join(".*")}$`, "i");
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

export interface CappedRuns {
  /** The oldest `maxRuns` completed runs — processed this invocation. */
  processed: WorkflowRun[];
  /** How many newer completed runs were deferred to the next collect. */
  deferred: number;
}

/**
 * Caps how many completed runs one invocation processes (`--max-runs`, a safety valve for huge
 * first backfills). The *oldest* runs go first: the watermark then advances only past what was
 * actually processed, so the deferred newer runs are simply re-listed — and collected — next
 * time. Zero data loss, bounded work per invocation.
 */
export function capRuns(completed: WorkflowRun[], maxRuns: number | undefined): CappedRuns {
  if (maxRuns === undefined || completed.length <= maxRuns) {
    return { processed: completed, deferred: 0 };
  }
  const oldestFirst = [...completed].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return { processed: oldestFirst.slice(0, maxRuns), deferred: completed.length - maxRuns };
}

/**
 * The runs the watermark may advance past: the processed completed runs plus the policy-excluded
 * runs. When `--max-runs` deferred newer completed runs, only excluded runs at or below the
 * processed ceiling count — the watermark must never pass a deferred (still uncollected) run.
 */
export function watermarkDisposal(
  processed: WorkflowRun[],
  excluded: WorkflowRun[],
  deferred: number,
): WorkflowRun[] {
  if (deferred === 0) {
    return [...processed, ...excluded];
  }
  const ceiling = processed.reduce((max, run) => (run.created_at > max ? run.created_at : max), "");
  return [...processed, ...excluded.filter((run) => run.created_at <= ceiling)];
}
