import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoEvents } from "../src/report/read.js";
import { compactRepo, listRepoSlugs } from "../src/store/compact.js";
import { readPartitionText } from "../src/store/compress.js";

/** A minimal stored event line; only the fields the reader/dedup touch. */
function line(runId: number, id = "t1"): string {
  return JSON.stringify({
    id,
    matrix: {},
    run: { run_id: runId, run_attempt: 1, started_at: "2026-04-01T00:00:00Z" },
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

describe("compactRepo", () => {
  let dataDir: string;
  let dir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "suitevitals-compact-"));
    dir = join(dataDir, "owner__repo");
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("compresses closed months and leaves the current month untouched", async () => {
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n${line(2)}\n`);
    await writeFile(join(dir, "2026-06.ndjson"), `${line(3)}\n`);

    const results = await compactRepo(dataDir, "owner/repo", "2026-06");

    expect(results.map((r) => r.month)).toEqual(["2026-04"]);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["2026-04.ndjson.zst", "2026-06.ndjson"]);
    // The compressed month round-trips to the original lines.
    const text = await readPartitionText(join(dir, "2026-04.ndjson.zst"));
    expect(text.trimEnd().split("\n")).toHaveLength(2);
  });

  it("is idempotent — an already-compacted month is skipped", async () => {
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n`);
    await compactRepo(dataDir, "owner/repo", "2026-06");
    const second = await compactRepo(dataDir, "owner/repo", "2026-06");
    expect(second).toEqual([]);
  });

  it("merges a raw sibling back into the compressed file (late append / crash recovery)", async () => {
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n`);
    await compactRepo(dataDir, "owner/repo", "2026-06");
    // A late append lands a new raw partition next to the .zst.
    await writeFile(join(dir, "2026-04.ndjson"), `${line(2)}\n`);

    await compactRepo(dataDir, "owner/repo", "2026-06");

    expect((await readdir(dir)).sort()).toEqual(["2026-04.ndjson.zst"]);
    const events = await collect(readRepoEvents(dataDir, "owner/repo"));
    expect(events.map((e) => e.run.run_id).sort()).toEqual([1, 2]);
  });

  it("dedups overlapping lines when merging both forms (crash mid-compaction)", async () => {
    // The .zst is renamed in, then a crash hits before the raw .ndjson is removed, so both
    // forms exist with the SAME lines. Merging them must not double-count.
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n${line(2)}\n`);
    await compactRepo(dataDir, "owner/repo", "2026-06");
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n${line(2)}\n`);

    await compactRepo(dataDir, "owner/repo", "2026-06");

    expect((await readdir(dir)).sort()).toEqual(["2026-04.ndjson.zst"]);
    const text = await readPartitionText(join(dir, "2026-04.ndjson.zst"));
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    const events = await collect(readRepoEvents(dataDir, "owner/repo"));
    expect(events.map((e) => e.run.run_id).sort()).toEqual([1, 2]);
  });

  it("returns nothing for a repo with no partition directory", async () => {
    expect(await compactRepo(dataDir, "owner/missing", "2026-06")).toEqual([]);
  });
});

describe("readRepoEvents with compaction", () => {
  let dataDir: string;
  let dir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "suitevitals-read-zst-"));
    dir = join(dataDir, "owner__repo");
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reads a compressed partition transparently", async () => {
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n${line(2)}\n`);
    await compactRepo(dataDir, "owner/repo", "2026-06");

    const events = await collect(readRepoEvents(dataDir, "owner/repo"));
    expect(events.map((e) => e.run.run_id)).toEqual([1, 2]);
  });

  it("dedups by key when both forms exist for a month", async () => {
    // Same event id+run in both files (a crash mid-compaction) must not double-count.
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n`);
    await compactRepo(dataDir, "owner/repo", "2026-06");
    await writeFile(join(dir, "2026-04.ndjson"), `${line(1)}\n${line(2)}\n`);

    const events = await collect(readRepoEvents(dataDir, "owner/repo"));
    expect(events.map((e) => e.run.run_id).sort()).toEqual([1, 2]);
  });
});

describe("listRepoSlugs", () => {
  it("maps partition directories back to slugs, or empty when the data dir is absent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "suitevitals-slugs-"));
    await mkdir(join(dataDir, "owner__repo"));
    await mkdir(join(dataDir, "acme__web"));
    await writeFile(join(dataDir, "loose.txt"), "x");

    expect(await listRepoSlugs(dataDir)).toEqual(["acme/web", "owner/repo"]);
    expect(await listRepoSlugs(join(dataDir, "nope"))).toEqual([]);

    await rm(dataDir, { recursive: true, force: true });
  });
});
