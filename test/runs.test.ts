import { describe, expect, it } from "vitest";
import { classifyRuns, missingPendingIds, type WorkflowRun } from "../src/github/runs.js";

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    run_id: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    workflow: "ci.yml",
    branch: "main",
    sha: "abc123",
    trigger: "push",
    created_at: "2026-06-23T10:00:00Z",
    ...overrides,
  };
}

describe("classifyRuns", () => {
  it("separates completed runs from in-progress/queued ones", () => {
    const runs = [
      run({ run_id: 1, status: "completed" }),
      run({ run_id: 2, status: "in_progress" }),
      run({ run_id: 3, status: "queued" }),
      run({ run_id: 4, status: "completed" }),
    ];

    const { completed, pending } = classifyRuns(runs);

    expect(completed.map((r) => r.run_id)).toEqual([1, 4]);
    expect(pending.map((r) => r.run_id)).toEqual([2, 3]);
  });

  it("treats any non-completed status as pending (never collected early)", () => {
    const { completed, pending } = classifyRuns([run({ status: "waiting" })]);
    expect(completed).toHaveLength(0);
    expect(pending).toHaveLength(1);
  });

  it("returns empty buckets for no runs", () => {
    expect(classifyRuns([])).toEqual({ completed: [], pending: [] });
  });
});

describe("missingPendingIds", () => {
  it("keeps only tracked ids the listing did not surface", () => {
    const listed = [run({ run_id: 1 }), run({ run_id: 3 })];
    expect(missingPendingIds([1, 2, 3, 4], listed)).toEqual([2, 4]);
  });

  it("is empty when nothing was tracked", () => {
    expect(missingPendingIds([], [run({ run_id: 1 })])).toEqual([]);
  });
});
