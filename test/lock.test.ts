import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDataDirLock, acquireLock, LockError } from "../src/state/lock.js";

describe("acquireLock", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-lock-"));
    path = join(dir, "state.json.lock");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires, records the pid, and releases", async () => {
    const release = await acquireLock(path);
    expect((await readFile(path, "utf8")).split("\n")[0]).toBe(String(process.pid));
    await release();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("fails fast with the holder's pid while the lock is held (F5)", async () => {
    const release = await acquireLock(path);
    await expect(acquireLock(path)).rejects.toThrow(LockError);
    await expect(acquireLock(path)).rejects.toThrow(String(process.pid));
    await release();
  });

  it("can be re-acquired after release", async () => {
    await (await acquireLock(path))();
    const release = await acquireLock(path);
    await release();
  });

  it("breaks a stale lock whose holder is no longer running", async () => {
    await writeFile(path, "12345\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const release = await acquireLock(path, { isPidAlive: () => false });
      expect((await readFile(path, "utf8")).split("\n")[0]).toBe(String(process.pid));
      expect(warn).toHaveBeenCalledOnce();
      await release();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still fails when the recorded holder is alive", async () => {
    await writeFile(path, "12345\n", "utf8");
    await expect(acquireLock(path, { isPidAlive: () => true })).rejects.toThrow(LockError);
  });

  it("never breaks a lock without a readable pid", async () => {
    // A garbled lock file could belong to anything — conservative: require the manual delete.
    await writeFile(path, "not-a-pid\n", "utf8");
    await expect(acquireLock(path, { isPidAlive: () => false })).rejects.toThrow(LockError);
  });

  it("never releases a lock that a successor now holds", async () => {
    const release = await acquireLock(path);
    await writeFile(path, "99999\nsomeone-else\n", "utf8");
    await release();
    expect(await readFile(path, "utf8")).toBe("99999\nsomeone-else\n");
  });

  it("lets only one of two racing processes break the same stale lock", async () => {
    await writeFile(path, "12345\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isPidAlive = (pid: number) => pid === process.pid;

    try {
      const results = await Promise.allSettled([
        acquireLock(path, { isPidAlive }),
        acquireLock(path, { isPidAlive }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(LockError);
      await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
    } finally {
      warn.mockRestore();
    }
  });

  it("breaks a lock left empty by a crash once it is old enough", async () => {
    await writeFile(path, "", "utf8");
    await expect(acquireLock(path)).rejects.toThrow(LockError);
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (await acquireLock(path))();
    } finally {
      warn.mockRestore();
    }
  });

  it("locks a data directory, creating it, so a second writer is refused", async () => {
    const dataDir = join(dir, "data");
    const release = await acquireDataDirLock(dataDir);
    await expect(acquireDataDirLock(dataDir)).rejects.toThrow(LockError);
    await release();
    await (await acquireDataDirLock(dataDir))();
  });
});
