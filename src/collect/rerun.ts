import type { WorkflowRun } from "../github/runs.js";
import type { RepoState } from "../state/state.js";

/** How far behind the window start runs are re-listed to catch re-runs of older runs. */
export const DEFAULT_RERUN_LOOKBACK_HOURS = 48;

/**
 * Where run listing starts: the window start, or `lookbackHours` before now if earlier. A repo
 * with no watermark has collected nothing yet, so it lists only its window.
 */
export function listingStart(
  windowSince: Date,
  now: Date,
  lookbackHours: number,
  hasWatermark = true,
): Date {
  if (!hasWatermark) {
    return windowSince;
  }
  const lookback = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  return lookback < windowSince ? lookback : windowSince;
}

/**
 * The re-run attempts already collected. For a repo with a watermark but no record yet, a listed
 * run before the window counts as collected at its current attempt only if that attempt started
 * before the repo's last collect.
 */
export function initialCollectedAttempts(
  previous: RepoState,
  listed: WorkflowRun[],
  windowSince: Date,
): Record<string, number> {
  if (previous.rerun_attempts) {
    return previous.rerun_attempts;
  }
  const seeded: Record<string, number> = {};
  const lastCollected = previous.last_collected_at;
  if (!previous.watermark || !lastCollected) {
    return seeded;
  }
  const sinceIso = windowSince.toISOString();
  for (const run of listed) {
    const startedBefore = run.run_started_at !== undefined && run.run_started_at <= lastCollected;
    if (run.created_at < sinceIso && run.run_attempt > 1 && startedBefore) {
      seeded[String(run.run_id)] = run.run_attempt;
    }
  }
  return seeded;
}

/**
 * Keeps every run inside the window and every tracked pending run, and a run from the lookback
 * stretch only when its attempt is newer than the one collected (`collectedAttempts`, default 1).
 */
export function selectRuns(
  runs: WorkflowRun[],
  windowSince: Date,
  collectedAttempts: Record<string, number>,
  pendingIds: number[] = [],
): { runs: WorkflowRun[]; reruns: number } {
  const sinceIso = windowSince.toISOString();
  const pending = new Set(pendingIds);
  const selected: WorkflowRun[] = [];
  let reruns = 0;
  for (const run of runs) {
    if (run.created_at >= sinceIso || pending.has(run.run_id)) {
      selected.push(run);
    } else if (run.run_attempt > (collectedAttempts[String(run.run_id)] ?? 1)) {
      selected.push(run);
      reruns++;
    }
  }
  return { runs: selected, reruns };
}

/**
 * The re-run attempts to save: the highest collected or filter-excluded attempt per run still in
 * the listing, kept only above attempt 1.
 */
export function nextCollectedAttempts(
  previous: Record<string, number>,
  listed: WorkflowRun[],
  disposed: WorkflowRun[],
): Record<string, number> {
  const listedIds = new Set(listed.map((run) => String(run.run_id)));
  const next: Record<string, number> = {};
  for (const [id, attempt] of Object.entries(previous)) {
    if (listedIds.has(id)) {
      next[id] = attempt;
    }
  }
  for (const run of disposed) {
    const id = String(run.run_id);
    if (run.run_attempt > 1 && run.run_attempt > (next[id] ?? 1)) {
      next[id] = run.run_attempt;
    }
  }
  return next;
}

/**
 * The highest attempt of `run` already collected: none for a run inside the window or a tracked
 * pending run, else the recorded attempt (default 1) of a run from the lookback stretch.
 */
export function alreadyCollectedAttempt(
  run: WorkflowRun,
  windowSince: Date,
  collectedAttempts: Record<string, number>,
  pendingIds: number[],
): number {
  if (run.created_at >= windowSince.toISOString() || pendingIds.includes(run.run_id)) {
    return 0;
  }
  return collectedAttempts[String(run.run_id)] ?? 1;
}
