import { open } from "node:fs/promises";

/** Writes `data` to `path` and fsyncs it before returning, so a later rename publishes it whole. */
export async function writeFileDurable(path: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Fsyncs a directory so a file created, renamed or removed in it survives a power loss. Windows
 * cannot open a directory for syncing (and does not need to), so that refusal is ignored.
 */
export async function syncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EISDIR" || code === "EPERM" || code === "EACCES") {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EINVAL") {
      throw error;
    }
  } finally {
    await handle.close();
  }
}
