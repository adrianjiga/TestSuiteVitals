import { join } from "node:path";
import type { TestEvent } from "../events/event.js";

/**
 * Month partition (`YYYY-MM`) an event belongs to, taken from the run's start time
 * so backfilled runs land in the month they ran, not the month they were collected (D1).
 */
export function partitionMonth(event: TestEvent): string {
  return event.run.started_at.slice(0, 7);
}

/** Directory name for a repo's partitions: `<owner>__<repo>` (D1). */
export function repoDir(slug: string): string {
  return slug.replace("/", "__");
}

/** Absolute path of a repo's monthly partition file. */
export function partitionPath(dataDir: string, slug: string, month: string): string {
  return join(dataDir, repoDir(slug), `${month}.ndjson`);
}
