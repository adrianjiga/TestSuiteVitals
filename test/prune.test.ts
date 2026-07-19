import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneCutoff, pruneRepo } from "../src/store/prune.js";

describe("pruneCutoff", () => {
  it("keeps only the current month at keep-months 1", () => {
    expect(pruneCutoff("2026-07", 1)).toBe("2026-07");
  });

  it("counts the current month toward the kept window", () => {
    expect(pruneCutoff("2026-07", 3)).toBe("2026-05");
  });

  it("crosses year boundaries", () => {
    expect(pruneCutoff("2026-07", 12)).toBe("2025-08");
    expect(pruneCutoff("2026-01", 2)).toBe("2025-12");
  });
});

describe("pruneRepo", () => {
  let dataDir: string;
  const slug = "owner/name";

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "suitevitals-prune-"));
    const dir = join(dataDir, "owner__name");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-04.ndjson.zst"), "old-compacted");
    await writeFile(join(dir, "2026-05.ndjson"), "old-raw");
    await writeFile(join(dir, "2026-06.ndjson"), "kept");
    await writeFile(join(dir, "notes.txt"), "not a partition");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("deletes only partition files older than the cutoff", async () => {
    const pruned = await pruneRepo(dataDir, slug, "2026-06", false);

    expect(pruned.map((p) => p.file)).toEqual(["2026-04.ndjson.zst", "2026-05.ndjson"]);
    expect(pruned.every((p) => p.bytes > 0)).toBe(true);
    // The kept month and the non-partition file survive.
    expect((await readdir(join(dataDir, "owner__name"))).sort()).toEqual([
      "2026-06.ndjson",
      "notes.txt",
    ]);
  });

  it("dry-run reports the same files but deletes nothing", async () => {
    const pruned = await pruneRepo(dataDir, slug, "2026-06", true);

    expect(pruned.map((p) => p.file)).toEqual(["2026-04.ndjson.zst", "2026-05.ndjson"]);
    expect((await readdir(join(dataDir, "owner__name"))).length).toBe(4);
  });

  it("yields nothing for a repo with no data directory", async () => {
    expect(await pruneRepo(dataDir, "owner/absent", "2026-06", false)).toEqual([]);
  });
});
