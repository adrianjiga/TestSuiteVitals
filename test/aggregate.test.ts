import { describe, expect, it } from "vitest";
import type { RunContext, TestEvent } from "../src/events/event.js";
import { aggregate } from "../src/report/aggregate.js";

/** Builds a TestEvent with sensible defaults; `run` is merged shallowly over the default run. */
function ev(over: Partial<Omit<TestEvent, "run">> & { run?: Partial<RunContext> } = {}): TestEvent {
  const { run, ...rest } = over;
  return {
    schema_version: 1,
    id: "t1",
    file: "a.spec.ts",
    title_path: ["A", "does x"],
    framework: "junit",
    source: "artifact",
    status: "passed",
    flaky: false,
    duration_ms: 10,
    attempts: [{ n: 1, status: "passed", duration_ms: 10 }],
    matrix: {},
    collected_at: "2026-06-01T00:00:00Z",
    ...rest,
    run: {
      provider: "github",
      repo: "o/r",
      run_id: 1,
      run_attempt: 1,
      workflow: "ci.yml",
      branch: "main",
      sha: "sha1",
      trigger: "push",
      started_at: "2026-06-01T00:00:00Z",
      ...run,
    },
  };
}

describe("aggregate grouping", () => {
  it("collapses matrix cells into one row by default", () => {
    const rows = aggregate([
      ev({ matrix: { browser: "chrome" }, run: { run_id: 1, sha: "s1" } }),
      ev({ matrix: { browser: "firefox" }, run: { run_id: 1, sha: "s1" } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalRuns).toBe(2);
    expect(rows[0]?.matrix).toBeUndefined();
  });

  it("splits per matrix cell when byMatrix is set", () => {
    const rows = aggregate(
      [
        ev({ matrix: { browser: "chrome" }, run: { run_id: 1, sha: "s1" } }),
        ev({ matrix: { browser: "firefox" }, run: { run_id: 1, sha: "s1" } }),
      ],
      { byMatrix: true },
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.totalRuns === 1)).toBe(true);
    expect(rows.map((r) => r.matrix?.browser).sort()).toEqual(["chrome", "firefox"]);
  });
});

describe("aggregate signals", () => {
  it("counts statuses, flaky/retried/rerun runs, and distinct fingerprints", () => {
    const rows = aggregate([
      ev({ status: "passed", run: { run_id: 1, sha: "s1" } }),
      ev({
        status: "failed",
        attempts: [
          { n: 1, status: "failed", duration_ms: 5, error: { message: "x", fingerprint: "fp1" } },
        ],
        run: { run_id: 2, sha: "s2" },
      }),
      ev({ status: "skipped", run: { run_id: 3, sha: "s3" } }),
      ev({
        status: "passed",
        flaky: true,
        attempts: [
          { n: 1, status: "failed", duration_ms: 5, error: { message: "y", fingerprint: "fp2" } },
          { n: 2, status: "passed", duration_ms: 6 },
        ],
        run: { run_id: 4, sha: "s4" },
      }),
      ev({ status: "passed", run: { run_id: 5, run_attempt: 2, sha: "s5" } }),
    ]);

    const [row] = rows;
    expect(row?.totalRuns).toBe(5);
    expect(row?.passed).toBe(3);
    expect(row?.failed).toBe(1);
    expect(row?.skipped).toBe(1);
    expect(row?.flakyRuns).toBe(1);
    expect(row?.retriedRuns).toBe(1);
    expect(row?.rerunRuns).toBe(1);
    expect(row?.fingerprints).toBe(2);
  });

  it("flags intermittence only when the same sha+cell saw both a pass and a fail", () => {
    const sameCell = aggregate([
      ev({ status: "passed", run: { run_id: 1, sha: "shared" } }),
      ev({ status: "failed", run: { run_id: 2, sha: "shared" } }),
    ]);
    expect(sameCell[0]?.distinctShas).toBe(1);
    expect(sameCell[0]?.intermittentShas).toBe(1);

    // Same sha but different matrix cells is environment-dependent, not intermittence.
    const crossCell = aggregate([
      ev({ status: "passed", matrix: { browser: "chrome" }, run: { run_id: 1, sha: "shared" } }),
      ev({ status: "failed", matrix: { browser: "firefox" }, run: { run_id: 2, sha: "shared" } }),
    ]);
    expect(crossCell[0]?.distinctShas).toBe(2);
    expect(crossCell[0]?.intermittentShas).toBe(0);
  });

  it("tracks the earliest and latest run start in the window", () => {
    const rows = aggregate([
      ev({ run: { run_id: 1, sha: "a", started_at: "2026-06-03T00:00:00Z" } }),
      ev({ run: { run_id: 2, sha: "b", started_at: "2026-06-01T00:00:00Z" } }),
      ev({ run: { run_id: 3, sha: "c", started_at: "2026-06-02T00:00:00Z" } }),
    ]);
    expect(rows[0]?.firstSeen).toBe("2026-06-01T00:00:00Z");
    expect(rows[0]?.lastSeen).toBe("2026-06-03T00:00:00Z");
  });
});
