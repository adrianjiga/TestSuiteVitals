import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compress } from "@mongodb-js/zstd";
import { NDJSON_EXT, partitionFileMonth, readPartitionText, ZSTD_EXT } from "./compress.js";
import { repoDir } from "./partition.js";

/** zstd level: high ratio is worth the CPU since closed months are written once (D2). */
const ZSTD_LEVEL = 19;

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
 * Crash safety: the new `.zst` is written to a temp file and atomically renamed before the raw
 * `.ndjson` is removed. A crash between leaves both files briefly; the reader dedups overlapping
 * keys per month, so neither double-counts.
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
    let text = "";
    for (const file of files) {
      const path = join(dir, file);
      bytesBefore += (await stat(path)).size;
      const part = await readPartitionText(path);
      text += part.length === 0 || part.endsWith("\n") ? part : `${part}\n`;
    }

    const compressed = await compress(Buffer.from(text, "utf8"), ZSTD_LEVEL);
    const finalPath = join(dir, `${month}${ZSTD_EXT}`);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, compressed);
    await rename(tmpPath, finalPath);
    await rm(join(dir, `${month}${NDJSON_EXT}`), { force: true });

    results.push({ month, bytesBefore, bytesAfter: compressed.length });
  }

  return results;
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
