import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TestEvent } from "../events/event.js";
import { partitionFileMonth, readPartitionText } from "../store/compress.js";
import { dedupKey } from "../store/dedup.js";
import { parseEventLine } from "../store/ndjson.js";
import { repoDir } from "../store/partition.js";

/** The error for a repo with no stored events, naming the resolved partition directory. */
export function noEventsError(dataDir: string, slug: string): Error {
  return new Error(
    `No collected events for ${slug} in ${resolve(dataDir, repoDir(slug))}. ` +
      `Run \`suitevitals collect --repo ${slug}\` first, or point --data-dir at the collected data.`,
  );
}

/**
 * Streams every stored event for a repo, oldest month first, so a long history is never fully
 * materialized in memory (D3). Partitions may be uncompressed (`.ndjson`) or zstd-compressed
 * (`.ndjson.zst`, D2); both are read transparently. A repo with no data directory yields nothing
 * rather than throwing; the commands turn "nothing stored at all" into {@link noEventsError}.
 *
 * When a month has both forms (a late append after compaction, or a crash mid-compaction), the
 * two are deduped by key so overlapping events are never double-counted.
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

  const byMonth = new Map<string, string[]>();
  for (const name of entries) {
    const month = partitionFileMonth(name);
    if (!month) {
      continue;
    }
    const files = byMonth.get(month) ?? [];
    files.push(name);
    byMonth.set(month, files);
  }

  for (const month of [...byMonth.keys()].sort()) {
    const files = (byMonth.get(month) ?? []).sort();
    if (files.length === 1) {
      yield* readPartitionFile(join(dir, files[0] as string));
      continue;
    }
    // Both compressed and raw forms exist — dedup by key within this month (bounded memory).
    const seen = new Set<string>();
    for (const file of files) {
      for await (const event of readPartitionFile(join(dir, file))) {
        const key = dedupKey(event);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        yield event;
      }
    }
  }
}

/**
 * Yields the events in one partition file, streaming `.ndjson` and decompressing `.ndjson.zst`.
 * Malformed lines (a torn write, a hand-edit) are skipped with a warning rather than aborting
 * the whole report (F4).
 */
async function* readPartitionFile(path: string): AsyncGenerator<TestEvent> {
  if (path.endsWith(".zst")) {
    const text = await readPartitionText(path);
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) {
        const event = parseEventLine(line, path);
        if (event) {
          yield event;
        }
      }
    }
    return;
  }
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.trim().length > 0) {
      const event = parseEventLine(line, path);
      if (event) {
        yield event;
      }
    }
  }
}
