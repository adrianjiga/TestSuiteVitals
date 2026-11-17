import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveTooLargeError, extractZip, extractZipNested } from "../src/artifacts/extract.js";

/** A zip-bomb-shaped archive: tiny compressed, `mb` MB of zeros declared uncompressed. */
function bombZip(mb: number): Uint8Array {
  return zipSync({ "huge.bin": new Uint8Array(mb * 1024 * 1024) });
}

describe("extractZip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-extract-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes files (including nested) and returns their paths", async () => {
    const zip = zipSync({
      "junit.xml": strToU8("<testsuites/>"),
      "nested/report.json": strToU8('{"ok":true}'),
    });

    const written = await extractZip(zip, dir);

    expect(written.map((p) => basename(p)).sort()).toEqual(["junit.xml", "report.json"]);
    const junit = written.find((p) => p.endsWith("junit.xml"));
    expect(await readFile(junit as string, "utf8")).toBe("<testsuites/>");
  });

  it("rejects entries that escape the destination (zip-slip)", async () => {
    const zip = zipSync({ "../escape.txt": strToU8("nope") });
    await expect(extractZip(zip, dir)).rejects.toThrow(/outside the destination/);
  });

  it("rejects an archive whose declared size blows the extraction budget (zip bomb)", async () => {
    // 2 MB of zeros compresses to ~2 KB but declares 2 MB — over a 1 MB budget.
    await expect(extractZip(bombZip(2), dir, 1024 * 1024)).rejects.toThrow(ArchiveTooLargeError);
  });

  it("counts the budget across entries, not per entry", async () => {
    const zip = zipSync({
      "a.bin": new Uint8Array(700 * 1024),
      "b.bin": new Uint8Array(700 * 1024),
    });
    await expect(extractZip(zip, dir, 1024 * 1024)).rejects.toThrow(ArchiveTooLargeError);
  });

  it("extracts normally when the archive fits the budget", async () => {
    const zip = zipSync({ "junit.xml": strToU8("<testsuites/>") });
    const written = await extractZip(zip, dir, 1024 * 1024);
    expect(written.map((p) => basename(p))).toEqual(["junit.xml"]);
  });
});

describe("extractZipNested", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-nested-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("unzips a zip-within-a-zip and returns the inner leaf file (Playwright blob)", async () => {
    const inner = zipSync({ "report.jsonl": strToU8('{"method":"onBegin"}') });
    const outer = zipSync({ "report-x.zip": inner });

    const leaves = await extractZipNested(outer, dir);

    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.endsWith("report.jsonl")).toBe(true);
    expect(await readFile(leaves[0] as string, "utf8")).toBe('{"method":"onBegin"}');
  });

  it("keeps a non-zip .zip entry instead of failing", async () => {
    const outer = zipSync({ "not-really.zip": strToU8("plain text") });
    const leaves = await extractZipNested(outer, dir);
    expect(leaves.map((p) => basename(p))).toEqual(["not-really.zip"]);
  });

  it("rethrows a budget blow-out from a nested archive (nested zip bomb)", async () => {
    const outer = zipSync({ "inner.zip": bombZip(2) });
    await expect(extractZipNested(outer, dir, 2, 1024 * 1024)).rejects.toThrow(
      ArchiveTooLargeError,
    );
  });

  it("counts every nested archive against one budget for the whole artifact", async () => {
    const inner = () => zipSync({ "part.bin": new Uint8Array(400 * 1024) }, { level: 9 });
    const outer = zipSync({ "a.zip": inner(), "b.zip": inner(), "c.zip": inner() }, { level: 0 });
    await expect(extractZipNested(outer, dir, 2, 1024 * 1024)).rejects.toThrow(
      ArchiveTooLargeError,
    );
  });
});
