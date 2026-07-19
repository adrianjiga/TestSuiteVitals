import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { partitionFileMonth } from "./compress.js";
import { repoDir } from "./partition.js";

/** One partition file pruned (or, dry-run, that would be pruned). */
export interface PrunedFile {
  month: string;
  file: string;
  bytes: number;
}

/**
 * The oldest month retained when keeping `keepMonths` months up to and including
 * `currentMonth` — files for months strictly before this cutoff are pruned. `keepMonths >= 1`,
 * so the current (open, append-hot) month always survives.
 */
export function pruneCutoff(currentMonth: string, keepMonths: number): string {
  const year = Number(currentMonth.slice(0, 4));
  const month = Number(currentMonth.slice(5, 7));
  const index = year * 12 + (month - 1) - (keepMonths - 1);
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/**
 * Deletes a repo's partition files (either form, D1/D2) for months older than `cutoff`.
 * Only recognized partition filenames are touched — anything else in the directory is left
 * alone. Pruned history is gone from reports immediately; a later backfill over the pruned
 * window would re-collect it (the dedup keys were deleted with the files), which is the
 * expected way to undo an over-eager prune while the artifacts still exist.
 */
export async function pruneRepo(
  dataDir: string,
  slug: string,
  cutoff: string,
  dryRun: boolean,
): Promise<PrunedFile[]> {
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

  const pruned: PrunedFile[] = [];
  for (const name of entries.sort()) {
    const month = partitionFileMonth(name);
    if (!month || month >= cutoff) {
      continue;
    }
    const path = join(dir, name);
    const bytes = (await stat(path)).size;
    if (!dryRun) {
      await rm(path);
    }
    pruned.push({ month, file: name, bytes });
  }
  return pruned;
}
