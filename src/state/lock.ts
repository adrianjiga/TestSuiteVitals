import { open, readFile, rm } from "node:fs/promises";

/** Thrown when the lock is already held — another collect is (or crashed while) running. */
export class LockError extends Error {
  override name = "LockError";
}

/**
 * Acquires an advisory single-writer lock by creating `path` exclusively (`wx`), writing the
 * holder's pid. Two overlapping `collect` runs on the same state file would otherwise race the
 * read-keys → append sequence into duplicate events and clobber each other's state (F5); the
 * loser now fails fast with a clear message instead. Returns a release function.
 *
 * The lock is advisory and can go stale if a holder is SIGKILLed; the error names the file and
 * its recorded pid so a stale lock is a one-command fix, not a mystery.
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const holder = await readFile(path, "utf8").then(
      (pid) => pid.trim(),
      () => "unknown",
    );
    throw new LockError(
      `Another collect appears to be running (lock ${path} held by pid ${holder}). ` +
        "If that process is gone, delete the lock file and retry.",
    );
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return async () => {
    await rm(path, { force: true });
  };
}
