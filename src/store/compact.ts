import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  compressPartition,
  NDJSON_EXT,
  partitionFileMonth,
  readPartitionText,
  ZSTD_EXT,
} from "./compress.js";
import { dedupKey } from "./dedup.js";
import { syncDir, writeFileDurable } from "./durable.js";
import { parseEventLine } from "./ndjson.js";
import { repoDir } from "./partition.js";

export interface MonthCompaction {
  month: string;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Compresses a repo's closed-month partitions to zstd (D2). The current month is left
 * uncompressed so appends stay cheap. Idempotent: a month that is already only `.ndjson.zst`
 * is skipped. If a month somehow has both forms (a late append after compaction, or a crash
 * mid-compaction), they are merged into one `.ndjson.zst`.
 *
 * Crash safety: the new `.zst` is written to a temp file, fsynced, and atomically renamed (with
 * the directory fsynced) before the raw `.ndjson` is removed. A crash between leaves both files
 * briefly; the reader dedups overlapping keys per month, so neither double-counts.
 */
export async function compactRepo(
  dataDir: string,
  slug: string,
  currentMonth: string,
): Promise<MonthCompaction[]> {
  const dir = join(dataDir, repoDir(slug));

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
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

  const results: MonthCompaction[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    if (month >= currentMonth) {
      continue; // the open current month stays uncompressed
    }
    const files = byMonth.get(month) ?? [];
    if (!files.includes(`${month}${NDJSON_EXT}`)) {
      continue; // already compacted (only the .zst form exists)
    }

    let bytesBefore = 0;
    for (const file of files) {
      bytesBefore += (await stat(join(dir, file))).size;
    }
    const text = await mergeMonth(dir, files);

    const compressed = await compressPartition(text);
    const finalPath = join(dir, `${month}${ZSTD_EXT}`);
    const tmpPath = `${finalPath}.tmp`;
    await writeFileDurable(tmpPath, compressed);
    await rename(tmpPath, finalPath);
    await syncDir(dir);
    await rm(join(dir, `${month}${NDJSON_EXT}`), { force: true });

    results.push({ month, bytesBefore, bytesAfter: compressed.length });
  }

  return results;
}

/**
 * The text to compress for a month. A single partition was already deduped at append time, so it
 * passes through unparsed (the common, fast path). When more than one form exists for the month — a
 * crash mid-compaction or a late backfill leaving a `.ndjson` beside the `.ndjson.zst` — the lines
 * are deduped by key so the merge never bakes in duplicates that the reader could no longer catch
 * (it only dedups a month while two files coexist). The first occurrence of a key wins, matching
 * the reader, and the original line bytes are emitted verbatim.
 */
async function mergeMonth(dir: string, files: string[]): Promise<string> {
  if (files.length === 1) {
    const only = await readPartitionText(join(dir, files[0] as string));
    return only.length === 0 || only.endsWith("\n") ? only : `${only}\n`;
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const file of [...files].sort()) {
    const path = join(dir, file);
    const raw = await readPartitionText(path);
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      // A line that cannot be keyed (corrupt) is kept verbatim — compaction must never
      // destroy data it cannot parse; the reader warns and skips such lines (F4).
      const event = parseEventLine(line, path);
      if (!event) {
        lines.push(line);
        continue;
      }
      const key = dedupKey(event);
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(line);
      }
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Lists the repo slugs that have a partition directory under `dataDir`. */
export async function listRepoSlugs(dataDir: string): Promise<string[]> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.includes("__"))
    .map((entry) => entry.name.replace("__", "/"))
    .sort();
}
