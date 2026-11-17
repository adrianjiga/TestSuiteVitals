import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { type UnzipFileInfo, unzipSync } from "fflate";

/** Default ceiling (MB) on a single archive's *decompressed* size — a zip-bomb / OOM guard (F1). */
export const DEFAULT_MAX_EXTRACT_MB = 500;

/** Declared uncompressed bytes extracted so far against a ceiling, shared across nested archives. */
interface ExtractionBudget {
  used: number;
  max: number;
}

/** Thrown when an archive's declared uncompressed size exceeds the extraction budget. */
export class ArchiveTooLargeError extends Error {
  override name = "ArchiveTooLargeError";
}

/**
 * Extracts a zip archive's bytes into `destDir`, returning the absolute paths of the written
 * files. Directory entries are skipped. Entry paths are validated to stay within `destDir` so a
 * malicious archive cannot escape via `../` (zip-slip). The summed declared uncompressed size is
 * capped at `maxBytes` and checked *before* each entry is inflated, so a zip bomb is rejected
 * (with {@link ArchiveTooLargeError}) rather than exhausting memory (F1).
 */
export function extractZip(
  zip: Uint8Array,
  destDir: string,
  maxBytes = DEFAULT_MAX_EXTRACT_MB * 1024 * 1024,
): Promise<string[]> {
  return extractWithBudget(zip, destDir, { used: 0, max: maxBytes });
}

async function extractWithBudget(
  zip: Uint8Array,
  destDir: string,
  budget: ExtractionBudget,
): Promise<string[]> {
  const entries = unzipSync(zip, { filter: budgetFilter(budget) });
  const written: string[] = [];

  for (const [name, bytes] of Object.entries(entries)) {
    // Directory entries are emitted with empty contents and a trailing slash.
    if (name.endsWith("/") || bytes.length === 0) {
      continue;
    }

    const target = safeJoin(destDir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written.push(target);
  }

  return written;
}

/**
 * Like {@link extractZip}, but also extracts nested zip archives up to `maxDepth` levels,
 * returning the leaf (non-zip) file paths. Playwright blob reports are double-zipped — the
 * artifact zip holds a `report-*.zip` which holds `report.jsonl` — so one nested level is
 * needed to surface the report. A nested entry that fails to unzip is kept as-is; a nested
 * entry that blows the extraction budget rethrows, since the whole artifact is hostile.
 */
export function extractZipNested(
  zip: Uint8Array,
  destDir: string,
  maxDepth = 2,
  maxBytes = DEFAULT_MAX_EXTRACT_MB * 1024 * 1024,
): Promise<string[]> {
  return extractNested(zip, destDir, maxDepth, { used: 0, max: maxBytes });
}

/**
 * One budget spans the whole artifact, nested archives included: a fresh budget per inner zip
 * would let an artifact of many small, highly compressed inner zips each expand to the full
 * ceiling, multiplying the bytes written to disk by the number of inner zips.
 */
async function extractNested(
  zip: Uint8Array,
  destDir: string,
  maxDepth: number,
  budget: ExtractionBudget,
): Promise<string[]> {
  const written = await extractWithBudget(zip, destDir, budget);
  if (maxDepth <= 1) {
    return written;
  }

  const leaves: string[] = [];
  for (const file of written) {
    if (!file.toLowerCase().endsWith(".zip")) {
      leaves.push(file);
      continue;
    }
    try {
      const bytes = await readFile(file);
      leaves.push(
        ...(await extractNested(new Uint8Array(bytes), `${file}.extracted`, maxDepth - 1, budget)),
      );
    } catch (error) {
      if (error instanceof ArchiveTooLargeError) {
        throw error;
      }
      // Not a readable zip; keep the file so nothing is silently lost.
      leaves.push(file);
    }
  }
  return leaves;
}

/**
 * A fflate entry filter that accumulates each entry's *declared* uncompressed size and throws
 * once the shared total exceeds `budget.max` — before the offending entry is inflated, so a zip bomb never
 * allocates its payload. (A crafted header could understate its size; the declared size catches
 * every realistic bomb and all accidental-OOM cases.)
 */
function budgetFilter(budget: ExtractionBudget): (file: UnzipFileInfo) => boolean {
  return (file) => {
    budget.used += file.originalSize;
    if (budget.used > budget.max) {
      throw new ArchiveTooLargeError(
        `Archive expands past the ${Math.round(budget.max / (1024 * 1024))} MB extraction budget; refusing to inflate.`,
      );
    }
    return true;
  };
}

/** Joins `name` onto `base`, throwing if the result escapes `base` (zip-slip guard). */
function safeJoin(base: string, name: string): string {
  const target = normalize(join(base, name));
  const root = normalize(base.endsWith(sep) ? base : base + sep);
  if (target !== normalize(base) && !target.startsWith(root)) {
    throw new Error(`Refusing to extract entry outside the destination: ${name}`);
  }
  return target;
}
