import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";

const compressAsync = promisify(zstdCompress);
const decompressAsync = promisify(zstdDecompress);

/** zstd level: high ratio is worth the CPU since closed months are written once (D2). */
const ZSTD_LEVEL = 19;

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
    return (await decompressAsync(buf)).toString("utf8");
  }
  return buf.toString("utf8");
}

/** Compresses a closed month's partition text into a `.ndjson.zst` payload. */
export function compressPartition(text: string): Promise<Buffer> {
  return compressAsync(Buffer.from(text, "utf8"), {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });
}
