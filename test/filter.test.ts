import { describe, expect, it } from "vitest";
import { capRuns, filterRuns, matchesGlob, watermarkDisposal } from "../src/collect/filter.js";
import type { WorkflowRun } from "../src/github/runs.js";

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    run_id: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    workflow: "CI",
    branch: "main",
    sha: "abc",
    trigger: "push",
    created_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

describe("matchesGlob", () => {
  it("matches literally, case-insensitively, with * as a wildcard", () => {
    expect(matchesGlob("CI", "ci")).toBe(true);
    expect(matchesGlob("e2e-*", "e2e-chromium")).toBe(true);
    expect(matchesGlob("*test*", "integration tests")).toBe(true);
    expect(matchesGlob("CI", "CI deploy")).toBe(false);
  });

  it("ignores spaces around the pattern, as from a padded shell variable", () => {
    expect(matchesGlob(" e2e-* ", "e2e-chromium")).toBe(true);
    expect(matchesGlob("Playwright Tests ", "Playwright Tests")).toBe(true);
  });

  it("treats regex metacharacters as literals", () => {
    expect(matchesGlob("ci.yml", "ci.yml")).toBe(true);
    expect(matchesGlob("ci.yml", "ciXyml")).toBe(false);
    expect(matchesGlob("a+b", "a+b")).toBe(true);
  });
});

describe("filterRuns", () => {
  const runs = [
    run({ run_id: 1, workflow: "CI", trigger: "push" }),
    run({ run_id: 2, workflow: "Deploy", trigger: "push" }),
    run({ run_id: 3, workflow: "CI", trigger: "pull_request" }),
  ];

  it("includes everything when the filter is empty", () => {
    const { included, excluded } = filterRuns(runs, {});
    expect(included).toHaveLength(3);
    expect(excluded).toHaveLength(0);
  });

  it("filters by workflow glob", () => {
    const { included, excluded } = filterRuns(runs, { workflow: "CI" });
    expect(included.map((r) => r.run_id)).toEqual([1, 3]);
    expect(excluded.map((r) => r.run_id)).toEqual([2]);
  });

  it("filters by excluded trigger", () => {
    const { included, excluded } = filterRuns(runs, { excludeTriggers: ["pull_request"] });
    expect(included.map((r) => r.run_id)).toEqual([1, 2]);
    expect(excluded.map((r) => r.run_id)).toEqual([3]);
  });

  it("applies both filters together", () => {
    const { included } = filterRuns(runs, { workflow: "CI", excludeTriggers: ["pull_request"] });
    expect(included.map((r) => r.run_id)).toEqual([1]);
  });
});

describe("capRuns", () => {
  const completed = [
    run({ run_id: 3, created_at: "2026-07-03T00:00:00Z" }),
    run({ run_id: 1, created_at: "2026-07-01T00:00:00Z" }),
    run({ run_id: 2, created_at: "2026-07-02T00:00:00Z" }),
  ];

  it("passes everything through when under the cap or uncapped", () => {
    expect(capRuns(completed, undefined)).toEqual({ processed: completed, deferred: 0 });
    expect(capRuns(completed, 3)).toEqual({ processed: completed, deferred: 0 });
  });

  it("keeps the oldest runs and defers the newer ones", () => {
    const { processed, deferred } = capRuns(completed, 2);
    expect(processed.map((r) => r.run_id)).toEqual([1, 2]);
    expect(deferred).toBe(1);
  });
});

describe("watermarkDisposal", () => {
  const processed = [run({ run_id: 1, created_at: "2026-07-01T00:00:00Z" })];
  const excluded = [
    run({ run_id: 10, created_at: "2026-06-30T00:00:00Z" }),
    run({ run_id: 11, created_at: "2026-07-05T00:00:00Z" }),
  ];

  it("passes all excluded runs when nothing was deferred", () => {
    expect(watermarkDisposal(processed, excluded, 0).map((r) => r.run_id)).toEqual([1, 10, 11]);
  });

  it("drops excluded runs above the processed ceiling when runs were deferred", () => {
    // A deferred run created 2026-07-02 must stay ahead of the watermark, so the newer
    // excluded run (2026-07-05) must not drag the watermark past it.
    expect(watermarkDisposal(processed, excluded, 1).map((r) => r.run_id)).toEqual([1, 10]);
  });
});
