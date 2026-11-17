import type { RepoState } from "../state/state.js";

/** First-run backfill when there is no watermark and no explicit override. */
export const DEFAULT_BACKFILL_HOURS = 72;

/** Where the collection window's start came from, for the summary and hints. */
export type WindowSource = "hours-back" | "watermark" | "default";

export interface CollectionWindow {
  /** Collect runs created at or after this instant. */
  since: Date;
  source: WindowSource;
}

export interface WindowOptions {
  /** `--hours-back N`: widen the window past the watermark; never narrows it. */
  hoursBack?: number | undefined;
  /** Current time; injectable for deterministic tests. */
  now?: Date;
}

/**
 * Computes the collection window start (D12 / collector window logic):
 *   the earlier of --hours-back and the stored watermark → else --hours-back alone →
 *   else the stored watermark → else a {@link DEFAULT_BACKFILL_HOURS}-hour first-run backfill.
 *
 * `--hours-back` may widen past the watermark because dedup makes overlapping collection
 * safe, but never narrows it.
 */
export function computeWindow(state: RepoState, options: WindowOptions = {}): CollectionWindow {
  const { hoursBack, now = new Date() } = options;

  const watermark = state.watermark ? new Date(state.watermark) : undefined;

  if (hoursBack !== undefined) {
    const requested = hoursAgo(now, hoursBack);
    if (watermark && watermark < requested) {
      return { since: watermark, source: "watermark" };
    }
    return { since: requested, source: "hours-back" };
  }

  if (watermark) {
    return { since: watermark, source: "watermark" };
  }

  return { since: hoursAgo(now, DEFAULT_BACKFILL_HOURS), source: "default" };
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}
