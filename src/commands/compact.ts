import { defineCommand } from "citty";
import { colorSupported, createPalette, type Palette } from "../colors.js";
import { parseRepoRef, repoSlug } from "../github/repo.js";
import { acquireDataDirLock, LockError } from "../state/lock.js";
import { compactRepo, listRepoSlugs } from "../store/compact.js";

const DEFAULT_DATA_DIR = "data";

export const compactCommand = defineCommand({
  meta: {
    name: "compact",
    description: "Compress closed-month partitions with zstd to reclaim disk",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to compact (default: every repo in the data directory)",
    },
    "data-dir": {
      type: "string",
      description: "Directory holding the NDJSON event partitions",
      default: DEFAULT_DATA_DIR,
    },
  },
  async run({ args }) {
    const palette = createPalette(colorSupported);
    const dataDir = args["data-dir"];
    const currentMonth = new Date().toISOString().slice(0, 7);

    const slugs = args.repo ? [repoSlug(parseRepoRef(args.repo))] : await listRepoSlugs(dataDir);

    if (slugs.length === 0) {
      console.log(palette.dim("No collected repositories to compact."));
      return;
    }

    let release: () => Promise<void>;
    try {
      release = await acquireDataDirLock(dataDir);
    } catch (error) {
      if (error instanceof LockError) {
        console.error(palette.bad(error.message));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    try {
      let months = 0;
      let before = 0;
      let after = 0;
      for (const slug of slugs) {
        for (const result of await compactRepo(dataDir, slug, currentMonth)) {
          months++;
          before += result.bytesBefore;
          after += result.bytesAfter;
          const saved = result.bytesBefore > 0 ? 1 - result.bytesAfter / result.bytesBefore : 0;
          console.log(
            `  ${palette.repo(slug)} ${result.month}: ${formatBytes(result.bytesBefore)} → ` +
              `${formatBytes(result.bytesAfter)} ${palette.good(`(${Math.round(saved * 100)}% smaller)`)}`,
          );
        }
      }

      if (months === 0) {
        console.log(palette.dim("Nothing to compact — all closed months are already compressed."));
        return;
      }
      printTotal(months, before, after, palette);
    } finally {
      await release();
    }
  },
});

function printTotal(months: number, before: number, after: number, palette: Palette): void {
  const saved = before > 0 ? 1 - after / before : 0;
  console.log(
    palette.heading(
      `Compacted ${months} month(s): ${formatBytes(before)} → ${formatBytes(after)} ` +
        `(${Math.round(saved * 100)}% smaller).`,
    ),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
