import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestEvent } from "../events/event.js";
import { repoDir } from "../store/partition.js";

/**
 * Streams every stored event for a repo, oldest partition first, one line at a time, so a
 * long history is never fully materialized in memory (D3). A repo with no data directory
 * yields nothing rather than throwing — reporting an un-collected repo is empty, not an error.
 */
export async function* readRepoEvents(dataDir: string, slug: string): AsyncGenerator<TestEvent> {
  const dir = join(dataDir, repoDir(slug));

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  // Partition files are `YYYY-MM.ndjson`; sorting the names sorts them chronologically.
  const partitions = entries.filter((name) => name.endsWith(".ndjson")).sort();

  for (const partition of partitions) {
    const lines = createInterface({
      input: createReadStream(join(dir, partition)),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      yield JSON.parse(line) as TestEvent;
    }
  }
}
