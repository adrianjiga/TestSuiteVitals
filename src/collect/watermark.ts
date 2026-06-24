import type { WorkflowRun } from "../github/runs.js";

function maxIso(values: string[]): string | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => (a > b ? a : b));
}

function minIso(values: string[]): string | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => (a < b ? a : b));
}

/**
 * Computes the next watermark (D12). It advances forward to the newest completed run,
 * but is held back so it never passes an in-progress run created within the just-scanned
 * range — when that run completes, the next window still includes it. It never moves
 * backward below `prev` (pending runs older than `prev` are re-checked by id via
 * `pending_runs`, not by the time window).
 */
export function nextWatermark(
  prev: string | undefined,
  completed: WorkflowRun[],
  pending: WorkflowRun[],
): string | undefined {
  let watermark = prev;

  const latestCompleted = maxIso(completed.map((run) => run.created_at));
  if (latestCompleted && (!watermark || latestCompleted > watermark)) {
    watermark = latestCompleted;
  }

  const earliestPending = minIso(pending.map((run) => run.created_at));
  if (
    earliestPending &&
    watermark &&
    earliestPending < watermark &&
    (!prev || earliestPending >= prev)
  ) {
    watermark = earliestPending;
  }

  return watermark;
}
