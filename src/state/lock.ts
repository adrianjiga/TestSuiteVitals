import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
 * holder's pid and a random token. Two overlapping `collect` runs on the same state file would otherwise race the
 * read-keys → append sequence into duplicate events and clobber each other's state (F5); the
 * loser fails fast with a clear message instead. Returns a release function.
 *
 * A lock whose recorded pid is no longer running is stale — the holder was SIGKILLed or died
 * without reaching its cleanup — and is broken automatically (with a note) rather than demanding
 * a manual delete; see {@link breakStaleLock} for why two processes racing that break cannot both
 * win. The lock also records a random token, so releasing it never deletes a successor's lock.
 */
export async function acquireLock(
  path: string,
  options: AcquireLockOptions = {},
): Promise<() => Promise<void>> {
  const { isPidAlive = defaultIsPidAlive } = options;
  const contents = `${process.pid}\n${randomUUID()}\n`;

  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(contents, "utf8");
      } finally {
        await handle.close();
      }
      return () => releaseIfOwned(path, contents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const holder = await readHolder(path);
      if (attempt < 3 && holder === undefined) {
        continue;
      }
      if (attempt < 3 && (await isStale(path, holder, isPidAlive))) {
        if (await breakStaleLock(path, holder)) {
          console.warn(`Breaking stale lock ${path}: holder ${holder || "(empty)"} is gone.`);
        }
        continue;
      }
      throw new LockError(
        `Another suitevitals process appears to be running (lock ${path} held by pid ` +
          `${holder || "unknown"}). If that process is gone, delete the lock file and retry.`,
      );
    }
  }
}

/** A lock left empty by a crash between create and write is stale once it is this old. */
const EMPTY_LOCK_GRACE_MS = 5000;

/** The holder pid on a lock's first line, `""` for an empty lock, undefined if unreadable. */
async function readHolder(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).split("\n")[0]?.trim() ?? "";
  } catch {
    return undefined;
  }
}

async function isStale(
  path: string,
  holder: string | undefined,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (holder === "") {
    const age = await stat(path).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    return age > EMPTY_LOCK_GRACE_MS;
  }
  const pid = Number(holder);
  return Number.isInteger(pid) && pid > 0 && !isPidAlive(pid);
}

/**
 * Removes a stale lock without ever removing a live one. Deleting by path is racy: two processes
 * that both saw the dead holder could each delete, and the slower one would delete the lock the
 * faster one had just re-created, leaving both "holding" it. Renaming the lock aside is atomic,
 * so exactly one process gets the file; it then checks the file still names the dead holder, and
 * if it grabbed a fresh live lock instead, links it back into place. Returns whether it broke it.
 */
async function breakStaleLock(path: string, holder: string | undefined): Promise<boolean> {
  const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if ((await readHolder(aside)) === holder) {
    await rm(aside, { force: true });
    return true;
  }
  await link(aside, path).catch(() => {});
  await rm(aside, { force: true });
  return false;
}

/** Releases the lock only while it is still this process's, never a successor's. */
async function releaseIfOwned(path: string, contents: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === contents) {
    await rm(path, { force: true });
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
