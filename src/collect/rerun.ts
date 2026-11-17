import type { WorkflowRun } from "../github/runs.js";

/**
 * How far behind the window start runs are re-listed to catch re-runs. A GitHub re-run keeps
 * the original `created_at`, so the `created`-filtered listing past the watermark never shows
 * a new attempt of an older run; re-runs of flaky tests land within days, not weeks.
 */
export const DEFAULT_RERUN_LOOKBACK_HOURS = 168;

/** Where run listing starts: the window start, or `lookbackHours` before now if earlier. */
export function listingStart(windowSince: Date, now: Date, lookbackHours: number): Date {
  const lookback = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  return lookback < windowSince ? lookback : windowSince;
}

/**
 * Keeps every run inside the window, and a run from the lookback stretch before it only when it
 * has an attempt newer than the last one collected (`collectedAttempts`, default 1) — so the
 * lookback re-collects re-runs without re-downloading every already-collected run.
 */
export function selectRuns(
  runs: WorkflowRun[],
  windowSince: Date,
  collectedAttempts: Record<string, number>,
): { runs: WorkflowRun[]; reruns: number } {
  const sinceIso = windowSince.toISOString();
  const selected: WorkflowRun[] = [];
  let reruns = 0;
  for (const run of runs) {
    if (run.created_at >= sinceIso) {
      selected.push(run);
    } else if (run.run_attempt > (collectedAttempts[String(run.run_id)] ?? 1)) {
      selected.push(run);
      reruns++;
    }
  }
  return { runs: selected, reruns };
}

/**
 * The re-run bookkeeping to save: the highest attempt collected per run, kept only for runs still
 * inside the listing (older ones can no longer be re-listed) and only above attempt 1 (the
 * default), so the map stays as small as the number of recent re-runs.
 */
export function nextCollectedAttempts(
  previous: Record<string, number>,
  listed: WorkflowRun[],
  processed: WorkflowRun[],
): Record<string, number> {
  const listedIds = new Set(listed.map((run) => String(run.run_id)));
  const next: Record<string, number> = {};
  for (const [id, attempt] of Object.entries(previous)) {
    if (listedIds.has(id)) {
      next[id] = attempt;
    }
  }
  for (const run of processed) {
    const id = String(run.run_id);
    if (run.run_attempt > 1 && run.run_attempt > (next[id] ?? 1)) {
      next[id] = run.run_attempt;
    }
  }
  return next;
}
