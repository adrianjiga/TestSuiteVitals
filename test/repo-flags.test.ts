import { describe, expect, it } from "vitest";
import { parseRepoFlags } from "../src/commands/repo-flags.js";

describe("parseRepoFlags", () => {
  it("collects a single --repo", () => {
    expect(parseRepoFlags(["--repo", "owner/a"])).toEqual(["owner/a"]);
  });

  it("collects every occurrence of a repeated --repo (the bug fix)", () => {
    expect(parseRepoFlags(["--repo", "owner/a", "--repo", "owner/b"])).toEqual([
      "owner/a",
      "owner/b",
    ]);
  });

  it("supports the --repo=value form", () => {
    expect(parseRepoFlags(["--repo=owner/a", "--repo=owner/b"])).toEqual(["owner/a", "owner/b"]);
  });

  it("ignores interleaved flags and preserves order", () => {
    expect(
      parseRepoFlags(["--repo", "owner/a", "--concurrency", "3", "--repo", "owner/b", "--dry-run"]),
    ).toEqual(["owner/a", "owner/b"]);
  });

  it("returns nothing when no --repo is present", () => {
    expect(parseRepoFlags(["--config", "repos.json"])).toEqual([]);
  });

  it("does not crash on a dangling --repo or one followed by another flag", () => {
    expect(parseRepoFlags(["--repo"])).toEqual([]);
    expect(parseRepoFlags(["--repo", "--dry-run"])).toEqual([]);
  });
});
