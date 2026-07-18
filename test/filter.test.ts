import { describe, expect, it } from "vitest";
import { filterRuns, matchesGlob } from "../src/collect/filter.js";
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
