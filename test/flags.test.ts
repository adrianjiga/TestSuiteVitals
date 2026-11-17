import { describe, expect, it } from "vitest";
import { parseCommaList, parseMatrixFlag, parseWorkflowFlag } from "../src/commands/flags.js";

describe("parseCommaList", () => {
  it("splits, trims and drops empty items", () => {
    expect(parseCommaList(" push, pull_request ,,", "--exclude-trigger", "x")).toEqual([
      "push",
      "pull_request",
    ]);
    expect(parseCommaList(undefined, "--exclude-trigger", "x")).toBeUndefined();
  });

  it("names the flag that was given in its error", () => {
    expect(() => parseCommaList(" , ", "--exclude-artifact", "artifact name globs")).toThrow(
      'Invalid --exclude-artifact " , ": expected artifact name globs.',
    );
  });
});

describe("parseWorkflowFlag", () => {
  it("rejects an empty glob, which would exclude every run", () => {
    expect(() => parseWorkflowFlag(" ")).toThrow('Invalid --workflow " "');
    expect(parseWorkflowFlag("e2e-*")).toBe("e2e-*");
    expect(parseWorkflowFlag(undefined)).toBeUndefined();
  });
});

describe("parseMatrixFlag", () => {
  it("rejects an empty value, invalid regex, or a pattern without a named group", () => {
    expect(() => parseMatrixFlag("")).toThrow(
      'Invalid --matrix-from-artifact "": expected a regex',
    );
    expect(() => parseMatrixFlag("(?<browser>")).toThrow(/not a valid regular expression/);
    expect(() => parseMatrixFlag("results-.*")).toThrow(/at least one named group/);
  });

  it("passes a valid pattern through", () => {
    expect(parseMatrixFlag("r-(?<browser>\\w+)")).toBe("r-(?<browser>\\w+)");
    expect(parseMatrixFlag(undefined)).toBeUndefined();
  });
});
