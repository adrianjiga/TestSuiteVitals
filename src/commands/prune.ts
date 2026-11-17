import { resolve } from "node:path";
import { defineCommand } from "citty";
import { colorSupported, createPalette, type Palette } from "../colors.js";
import { parseRepoRef, repoSlug } from "../github/repo.js";
import { withDataDirLock } from "../state/lock.js";
import { listRepoSlugs } from "../store/compact.js";
import { pruneCutoff, pruneRepo } from "../store/prune.js";

const DEFAULT_DATA_DIR = "data";

export const pruneCommand = defineCommand({
  meta: {
    name: "prune",
    description: "Delete partition months older than a retention window",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to prune (default: every repo in the data directory)",
    },
    "data-dir": {
      type: "string",
      description: "Directory holding the NDJSON event partitions",
      default: DEFAULT_DATA_DIR,
    },
    "keep-months": {
      type: "string",
      description: "Months of history to keep, counting the current month (required)",
      required: true,
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would be deleted without deleting anything",
      default: false,
    },
  },
  async run({ args }) {
    const palette = createPalette(colorSupported);
    const dataDir = args["data-dir"];
    const keepMonths = parseKeepMonths(args["keep-months"]);
    const cutoff = pruneCutoff(new Date().toISOString().slice(0, 7), keepMonths);

    const slugs = args.repo ? [repoSlug(parseRepoRef(args.repo))] : await listRepoSlugs(dataDir);
    if (slugs.length === 0) {
      console.log(palette.dim(`No collected repositories to prune in ${resolve(dataDir)}.`));
      return;
    }

    await withDataDirLock(dataDir, async () => {
      const verb = args["dry-run"] ? "Would delete" : "Deleted";
      let files = 0;
      let bytes = 0;
      for (const slug of slugs) {
        for (const pruned of await pruneRepo(dataDir, slug, cutoff, args["dry-run"])) {
          files++;
          bytes += pruned.bytes;
          console.log(
            `  ${palette.repo(slug)} ${pruned.month}: ${verb} ${pruned.file} (${formatBytes(pruned.bytes)}).`,
          );
        }
      }

      if (files === 0) {
        console.log(palette.dim(`Nothing to prune — no partitions older than ${cutoff}.`));
        return;
      }
      printTotal(verb, files, bytes, cutoff, palette);
    });
  },
});

function printTotal(verb: string, files: number, bytes: number, cutoff: string, p: Palette): void {
  console.log(
    p.heading(
      `${verb} ${files} partition file(s) older than ${cutoff}, freeing ${formatBytes(bytes)}.`,
    ),
  );
}

/** Parses and validates `--keep-months`; at least 1 so the current month always survives. */
function parseKeepMonths(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --keep-months "${value}": expected a positive integer.`);
  }
  return n;
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
