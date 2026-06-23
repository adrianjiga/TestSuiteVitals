import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZip } from "../src/artifacts/extract.js";

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
});
