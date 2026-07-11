import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { getRepoFile } from "../src/github/contents.js";

const REF = { owner: "o", repo: "r" };

/** A stub Octokit whose getContent resolves with the given payload (or rejects). */
function octokitWith(data: unknown, error?: { status: number }): Octokit {
  return {
    rest: {
      repos: {
        getContent: async () => {
          if (error) {
            throw Object.assign(new Error("boom"), error);
          }
          return { data };
        },
      },
    },
  } as unknown as Octokit;
}

describe("getRepoFile", () => {
  it("decodes a base64 file", async () => {
    const octokit = octokitWith({
      type: "file",
      content: Buffer.from('{"name":"x"}', "utf8").toString("base64"),
      encoding: "base64",
    });
    expect(await getRepoFile(octokit, REF, "package.json")).toBe('{"name":"x"}');
  });

  it('returns null for a >1 MB file (encoding "none") instead of crashing (F6)', async () => {
    const octokit = octokitWith({ type: "file", content: "", encoding: "none" });
    expect(await getRepoFile(octokit, REF, "package.json")).toBeNull();
  });

  it("returns null on 404 and for non-file responses", async () => {
    expect(await getRepoFile(octokitWith(undefined, { status: 404 }), REF, "x")).toBeNull();
    expect(await getRepoFile(octokitWith([{ type: "file" }]), REF, "dir")).toBeNull();
  });

  it("propagates non-404 errors", async () => {
    await expect(getRepoFile(octokitWith(undefined, { status: 500 }), REF, "x")).rejects.toThrow();
  });
});
