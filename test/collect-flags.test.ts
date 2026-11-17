import { describe, expect, it } from "vitest";
import { parseCommaList } from "../src/commands/collect.js";

describe("parseCommaList", () => {
  it("splits, trims and drops empty items", () => {
    expect(parseCommaList(" push, pull_request ,,", "--exclude-trigger", "x")).toEqual([
      "push",
      "pull_request",
    ]);
    expect(parseCommaList(undefined, "--exclude-trigger", "x")).toBeUndefined();
  });

  it("names the flag that was actually given in its error", () => {
    expect(() => parseCommaList(" , ", "--exclude-artifact", "artifact name globs")).toThrow(
      'Invalid --exclude-artifact " , ": expected artifact name globs.',
    );
    expect(() => parseCommaList(",", "--exclude-trigger", "trigger event names")).toThrow(
      'Invalid --exclude-trigger ",": expected trigger event names.',
    );
  });
});
