import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { TestEvent } from "../events/event.js";
import { readPartitionText } from "./compress.js";
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
 * with a single append that is fsynced before returning, so the D12 "durable append →
 * then advance the watermark" ordering holds even across power loss. (A torn line from a
 * mid-write crash is still possible; the reader skips such lines rather than failing.)
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
      const handle = await open(path, "a");
      try {
        await handle.writeFile(`${lines.join("\n")}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
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

/**
 * Reads the dedup keys already present for a month, from both the uncompressed partition and a
 * compacted `.ndjson.zst` sibling (D2) if present — so a late backfill into a compacted month is
 * still deduped. Missing files yield no keys.
 */
async function readExistingKeys(path: string): Promise<Set<string>> {
  const keys = new Set<string>();
  await addKeysFrom(path, keys);
  await addKeysFrom(`${path}.zst`, keys);
  return keys;
}

async function addKeysFrom(path: string, keys: Set<string>): Promise<void> {
  let raw: string;
  try {
    raw = await readPartitionText(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length > 0) {
      const event = parseEventLine(line, path);
      if (event) {
        keys.add(dedupKey(event));
      }
    }
  }
}

/**
 * Parses one stored NDJSON line into an event, or returns null (with a warning naming the
 * file) when the line is corrupt — a torn write or a hand-edit must degrade to one lost
 * record, never brick every future `collect` and `report` for the repo (F4).
 */
export function parseEventLine(line: string, source: string): TestEvent | null {
  try {
    return JSON.parse(line) as TestEvent;
  } catch {
    console.warn(`Skipping malformed line in ${source} (corrupt partition?).`);
    return null;
  }
}
