import { mkdir, writeFile } from "node:fs/promises";
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

/** Joins `name` onto `base`, throwing if the result escapes `base` (zip-slip guard). */
function safeJoin(base: string, name: string): string {
  const target = normalize(join(base, name));
  const root = normalize(base.endsWith(sep) ? base : base + sep);
  if (target !== normalize(base) && !target.startsWith(root)) {
    throw new Error(`Refusing to extract entry outside the destination: ${name}`);
  }
  return target;
}
