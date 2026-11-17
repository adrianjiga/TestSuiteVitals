import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncDir, writeFileDurable } from "../src/store/durable.js";

describe("durable writes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-durable-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and replaces a file's full contents", async () => {
    const path = join(dir, "file.tmp");
    await writeFileDurable(path, "first, longer contents");
    await writeFileDurable(path, new Uint8Array([104, 105]));
    expect(await readFile(path, "utf8")).toBe("hi");
  });

  it("syncs a directory and rejects one that does not exist", async () => {
    await expect(syncDir(dir)).resolves.toBeUndefined();
    await expect(syncDir(join(dir, "missing"))).rejects.toThrow();
  });
});
