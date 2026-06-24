import { describe, expect, it } from "vitest";
import { nextWatermark } from "../src/collect/watermark.js";
import type { WorkflowRun } from "../src/github/runs.js";

function run(createdAt: string, status = "completed"): WorkflowRun {
  return {
    run_id: Number(createdAt.slice(11, 13)),
    run_attempt: 1,
    status,
    conclusion: status === "completed" ? "success" : null,
    workflow: "ci.yml",
    branch: "main",
    sha: "x",
    trigger: "push",
    created_at: createdAt,
  };
}

describe("nextWatermark", () => {
  it("advances to the newest completed run", () => {
    const completed = [run("2026-06-24T10:00:00Z"), run("2026-06-24T12:00:00Z")];
    expect(nextWatermark(undefined, completed, [])).toBe("2026-06-24T12:00:00Z");
  });

  it("never moves backward below the previous watermark", () => {
    const completed = [run("2026-06-20T00:00:00Z")];
    expect(nextWatermark("2026-06-23T00:00:00Z", completed, [])).toBe("2026-06-23T00:00:00Z");
  });

  it("holds back so it does not pass an in-progress run", () => {
    const completed = [run("2026-06-24T14:00:00Z")];
    const pending = [run("2026-06-24T13:00:00Z", "in_progress")];
    // Newest completed is 14:00, but a run started at 13:00 is still in progress.
    expect(nextWatermark("2026-06-24T09:00:00Z", completed, pending)).toBe("2026-06-24T13:00:00Z");
  });

  it("ignores pending runs older than the previous watermark (handled by id re-check)", () => {
    const completed = [run("2026-06-24T14:00:00Z")];
    const pending = [run("2026-06-20T00:00:00Z", "queued")];
    expect(nextWatermark("2026-06-23T00:00:00Z", completed, pending)).toBe("2026-06-24T14:00:00Z");
  });

  it("keeps the previous watermark when nothing was collected", () => {
    expect(nextWatermark("2026-06-23T00:00:00Z", [], [])).toBe("2026-06-23T00:00:00Z");
  });
});
