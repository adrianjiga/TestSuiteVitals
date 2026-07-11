import { describe, expect, it } from "vitest";
import { parseRepoRef, repoSlug } from "../src/github/repo.js";

describe("parseRepoRef", () => {
  it("parses a valid owner/name", () => {
    expect(parseRepoRef("adrianjiga/TestSuiteVitals")).toEqual({
      owner: "adrianjiga",
      repo: "TestSuiteVitals",
    });
  });

  it("accepts dots, dashes, and underscores", () => {
    expect(parseRepoRef("some-org/my_repo.js")).toEqual({
      owner: "some-org",
      repo: "my_repo.js",
    });
  });

  it.each([
    "",
    "owner",
    "owner/",
    "/name",
    "a/b/c",
    "own er/name",
    "owner/na me",
    // Path-semantics segments: GitHub never issues these, and they feed data/ paths (F7).
    "../name",
    "owner/..",
    "./name",
    "owner/.",
  ])("rejects %j", (value) => {
    expect(() => parseRepoRef(value)).toThrow(/owner\/name/);
  });

  it("round-trips through repoSlug", () => {
    const ref = parseRepoRef("adrianjiga/TestSuiteVitals");
    expect(repoSlug(ref)).toBe("adrianjiga/TestSuiteVitals");
  });
});
