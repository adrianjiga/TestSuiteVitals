import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Thrown when the lock is already held — another suitevitals process is running. */
export class LockError extends Error {
  override name = "LockError";
}

export interface AcquireLockOptions {
  /** Overrides pid-liveness detection; injectable for tests. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Acquires an advisory single-writer lock by creating `path` exclusively (`wx`), writing the
 * holder's pid. Two overlapping `collect` runs on the same state file would otherwise race the
 * read-keys → append sequence into duplicate events and clobber each other's state (F5); the
 * loser fails fast with a clear message instead. Returns a release function.
 *
 * A lock whose recorded pid is no longer running is stale — the holder was SIGKILLed or died
 * without reaching its cleanup — and is broken automatically (with a note) rather than demanding
 * a manual delete. If two processes race the same stale break, exactly one wins the exclusive
 * re-create; the other reads the new, live holder and fails as held.
 */
export async function acquireLock(
  path: string,
  options: AcquireLockOptions = {},
): Promise<() => Promise<void>> {
  const { isPidAlive = defaultIsPidAlive } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const holder = await readFile(path, "utf8").then(
        (pid) => pid.trim() || "unknown",
        () => "unknown",
      );
      const pid = Number(holder);
      if (attempt === 0 && Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) {
        console.warn(`Breaking stale lock ${path}: holder pid ${pid} is no longer running.`);
        await rm(path, { force: true });
        continue;
      }
      throw new LockError(
        `Another suitevitals process appears to be running (lock ${path} held by pid ${holder}). ` +
          "If that process is gone, delete the lock file and retry.",
      );
    }
  }
}

/**
 * Locks a data directory, so `compact`/`prune` never delete a partition file that a concurrent
 * `collect` is appending to (the appended events would vanish with the file while that collect
 * advanced its watermark past them).
 */
export async function acquireDataDirLock(
  dataDir: string,
  options: AcquireLockOptions = {},
): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  return acquireLock(join(dataDir, ".lock"), options);
}

/** True when `pid` is a running process; EPERM means alive but owned by another user. */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
