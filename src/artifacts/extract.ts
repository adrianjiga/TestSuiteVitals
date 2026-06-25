import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { unzipSync } from "fflate";

/**
 * Extracts a zip archive's bytes into `destDir`, returning the absolute paths of
 * the written files. Directory entries are skipped. Entry paths are validated to
 * stay within `destDir` so a malicious archive cannot escape via `../` (zip-slip).
 */
export async function extractZip(zip: Uint8Array, destDir: string): Promise<string[]> {
  const entries = unzipSync(zip);
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
 * needed to surface the report. A nested entry that fails to unzip is kept as-is.
 */
export async function extractZipNested(
  zip: Uint8Array,
  destDir: string,
  maxDepth = 2,
): Promise<string[]> {
  const written = await extractZip(zip, destDir);
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
        ...(await extractZipNested(new Uint8Array(bytes), `${file}.extracted`, maxDepth - 1)),
      );
    } catch {
      // Not a readable zip; keep the file so nothing is silently lost.
      leaves.push(file);
    }
  }
  return leaves;
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
