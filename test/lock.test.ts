import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, LockError } from "../src/state/lock.js";

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
    expect((await readFile(path, "utf8")).trim()).toBe(String(process.pid));
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
      expect((await readFile(path, "utf8")).trim()).toBe(String(process.pid));
      expect(warn).toHaveBeenCalledOnce();
      await release();
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
});
