import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TestEvent } from "../events/event.js";
import { dedupKey } from "./dedup.js";
import { partitionMonth, partitionPath } from "./partition.js";

export interface AppendResult {
  written: number;
  deduped: number;
  partitions: number;
}

/**
 * Appends events to their monthly partitions (D1), skipping any whose dedup key already
 * exists in the partition or repeats within this batch (D12). Each partition is written
 * with a single append call so a crash cannot leave a half-written line.
 */
export async function appendEvents(
  dataDir: string,
  slug: string,
  events: TestEvent[],
): Promise<AppendResult> {
  const byMonth = groupByMonth(events);
  let written = 0;
  let deduped = 0;

  for (const [month, monthEvents] of byMonth) {
    const path = partitionPath(dataDir, slug, month);
    const seen = await readExistingKeys(path);

    const lines: string[] = [];
    for (const event of monthEvents) {
      const key = dedupKey(event);
      if (seen.has(key)) {
        deduped++;
        continue;
      }
      seen.add(key);
      lines.push(JSON.stringify(event));
      written++;
    }

    if (lines.length > 0) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${lines.join("\n")}\n`, "utf8");
    }
  }

  return { written, deduped, partitions: byMonth.size };
}

function groupByMonth(events: TestEvent[]): Map<string, TestEvent[]> {
  const groups = new Map<string, TestEvent[]>();
  for (const event of events) {
    const month = partitionMonth(event);
    const bucket = groups.get(month);
    if (bucket) {
      bucket.push(event);
    } else {
      groups.set(month, [event]);
    }
  }
  return groups;
}

/** Reads the dedup keys already present in a partition; a missing file yields an empty set. */
async function readExistingKeys(path: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }

  const keys = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    keys.add(dedupKey(JSON.parse(line) as TestEvent));
  }
  return keys;
}
