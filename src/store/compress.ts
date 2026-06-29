import { readFile } from "node:fs/promises";
import { decompress } from "@mongodb-js/zstd";

/** Uncompressed monthly partition extension (D1). */
export const NDJSON_EXT = ".ndjson";
/** zstd-compressed closed-month partition extension (D2). */
export const ZSTD_EXT = ".ndjson.zst";

/**
 * The month a partition filename belongs to, e.g. `2026-05.ndjson` or `2026-05.ndjson.zst`
 * → `2026-05`. Returns undefined for anything that is not a partition file.
 */
export function partitionFileMonth(name: string): string | undefined {
  const match = /^(\d{4}-\d{2})\.ndjson(\.zst)?$/.exec(name);
  return match?.[1];
}

/** Reads a partition file as UTF-8 text, transparently decompressing a `.ndjson.zst`. */
export async function readPartitionText(path: string): Promise<string> {
  const buf = await readFile(path);
  if (path.endsWith(".zst")) {
    return (await decompress(buf)).toString("utf8");
  }
  return buf.toString("utf8");
}
