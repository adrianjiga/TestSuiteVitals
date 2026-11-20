import { describe, expect, it } from "vitest";
import { aggregate } from "../src/report/aggregate.js";
import { ev, failed, hour } from "./helpers/events.js";

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

  it("keeps cells apart whose flattened forms would collide", () => {
    // A `key=value,…` cell key renders both of these as `a=x,b=y` and would merge them.
    const rows = aggregate(
      [
        ev({ matrix: { a: "x,b=y" }, run: { run_id: 1, sha: "s1" } }),
        ev({ matrix: { a: "x", b: "y" }, run: { run_id: 1, sha: "s1" } }),
      ],
      { byMatrix: true },
    );
    expect(rows).toHaveLength(2);
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

  it("collects a time-ordered outcome timeline only when requested", () => {
    const events = [
      ev({ status: "passed", run: { run_id: 2, sha: "b", started_at: "2026-06-02T00:00:00Z" } }),
      ev({ status: "failed", run: { run_id: 1, sha: "a", started_at: "2026-06-01T00:00:00Z" } }),
      ev({
        status: "passed",
        flaky: true,
        run: { run_id: 3, sha: "c", started_at: "2026-06-03T00:00:00Z" },
      }),
    ];
    expect(aggregate(events)[0]?.timeline).toBeUndefined();
    // Sorted by run start; a flaky run is distinguished from a clean pass.
    expect(aggregate(events, { timeline: true })[0]?.timeline).toEqual([
      "failed",
      "passed",
      "flaky",
    ]);
  });
});

describe("aggregate flips", () => {
  it("counts pass/fail transitions in run-start order, whatever the input order", () => {
    const rows = aggregate([
      ev({ run: { run_id: 3, sha: "c", started_at: hour(3) } }),
      failed({ run: { run_id: 2, sha: "b", started_at: hour(2) } }),
      ev({ run: { run_id: 1, sha: "a", started_at: hour(1) } }),
      failed({ run: { run_id: 4, sha: "d", started_at: hour(4) } }),
    ]);
    // pass → fail → pass → fail: three flips across three consecutive pairs.
    expect(rows[0]?.flips).toBe(3);
    expect(rows[0]?.flipPairs).toBe(3);
  });

  it("ignores skips, which neither flip nor break a streak", () => {
    const rows = aggregate([
      ev({ run: { run_id: 1, sha: "a", started_at: hour(1) } }),
      ev({ status: "skipped", run: { run_id: 2, sha: "b", started_at: hour(2) } }),
      ev({ run: { run_id: 3, sha: "c", started_at: hour(3) } }),
    ]);
    expect(rows[0]?.flips).toBe(0);
    expect(rows[0]?.flipPairs).toBe(1);
  });

  it("counts only push and schedule runs, where the code between runs barely changes", () => {
    const rows = aggregate([
      ev({ run: { run_id: 1, sha: "a", trigger: "pull_request", started_at: hour(1) } }),
      failed({ run: { run_id: 2, sha: "b", trigger: "pull_request", started_at: hour(2) } }),
      ev({ run: { run_id: 3, sha: "c", trigger: "schedule", started_at: hour(3) } }),
      failed({ run: { run_id: 4, sha: "d", trigger: "push", started_at: hour(4) } }),
    ]);
    expect(rows[0]?.flips).toBe(1);
    expect(rows[0]?.flipPairs).toBe(1);
  });

  it("keeps a separate sequence per branch and matrix cell", () => {
    // Interleaved, these alternate pass/fail; per (branch, cell) each sequence is constant.
    const rows = aggregate([
      ev({ matrix: { os: "linux" }, run: { run_id: 1, sha: "a", started_at: hour(1) } }),
      failed({ matrix: { os: "mac" }, run: { run_id: 1, sha: "a", started_at: hour(1) } }),
      ev({ matrix: { os: "linux" }, run: { run_id: 2, sha: "b", started_at: hour(2) } }),
      failed({ matrix: { os: "mac" }, run: { run_id: 2, sha: "b", started_at: hour(2) } }),
      ev({ run: { run_id: 3, branch: "release", sha: "c", started_at: hour(3) } }),
      failed({ run: { run_id: 4, branch: "main", sha: "d", started_at: hour(4) } }),
    ]);
    expect(rows[0]?.flips).toBe(0);
    expect(rows[0]?.flipPairs).toBe(2);
  });

  it("orders a re-run after its first attempt when both share a start time", () => {
    const rows = aggregate([
      ev({ run: { run_id: 1, run_attempt: 2, sha: "a", started_at: hour(1) } }),
      failed({ run: { run_id: 1, run_attempt: 1, sha: "a", started_at: hour(1) } }),
      ev({ run: { run_id: 2, sha: "b", started_at: hour(2) } }),
    ]);
    expect(rows[0]?.flips).toBe(1);
    expect(rows[0]?.flipPairs).toBe(2);
  });
});
