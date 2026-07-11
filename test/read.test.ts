import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepoEvents } from "../src/report/read.js";

/** Collects an async iterable into an array. */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

/** A minimal stored event line carrying just the fields the reader passes through. */
function line(id: string, runId: number): string {
  return JSON.stringify({ id, run: { run_id: runId } });
}

describe("readRepoEvents", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "suitevitals-read-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("yields nothing for a repo that was never collected", async () => {
    expect(await collect(readRepoEvents(dataDir, "owner/missing"))).toEqual([]);
  });

  it("streams events across partitions oldest month first, skipping blank lines", async () => {
    const dir = join(dataDir, "owner__repo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-06.ndjson"), `${line("c", 3)}\n\n${line("d", 4)}\n`);
    await writeFile(join(dir, "2026-05.ndjson"), `${line("a", 1)}\n${line("b", 2)}\n`);

    const events = await collect(readRepoEvents(dataDir, "owner/repo"));
    expect(events.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("skips a malformed line with a warning instead of aborting the stream (F4)", async () => {
    const dir = join(dataDir, "owner__repo");
    await mkdir(dir, { recursive: true });
    // A torn write leaves a truncated JSON line between two good ones.
    await writeFile(join(dir, "2026-06.ndjson"), `${line("a", 1)}\n{"id":"tor\n${line("b", 2)}\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await collect(readRepoEvents(dataDir, "owner/repo"));
      expect(events.map((e) => e.id)).toEqual(["a", "b"]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/malformed line/i);
    } finally {
      warn.mockRestore();
    }
  });
});
