import { describe, expect, it } from "vitest";
import {
  alreadyCollectedAttempt,
  initialCollectedAttempts,
  listingStart,
  nextCollectedAttempts,
  selectRuns,
} from "../src/collect/rerun.js";
import type { WorkflowRun } from "../src/github/runs.js";

function run(id: number, createdAt: string, attempt = 1): WorkflowRun {
  return {
    run_id: id,
    run_attempt: attempt,
    status: "completed",
    conclusion: "success",
    workflow: "ci.yml",
    branch: "main",
    sha: "abc",
    trigger: "push",
    created_at: createdAt,
  };
}

const NOW = new Date("2026-06-23T12:00:00Z");
const WINDOW = new Date("2026-06-23T00:00:00Z");

describe("listingStart", () => {
  it("reaches back past the window start by the lookback", () => {
    expect(listingStart(WINDOW, NOW, 168)).toEqual(new Date("2026-06-16T12:00:00Z"));
  });

  it("keeps a window start that is already earlier than the lookback", () => {
    const wide = new Date("2026-06-01T00:00:00Z");
    expect(listingStart(wide, NOW, 168)).toEqual(wide);
  });

  it("is just the window start before a repo's first collect", () => {
    expect(listingStart(WINDOW, NOW, 168, false)).toEqual(WINDOW);
  });

  it("is just the window start when the lookback is disabled", () => {
    expect(listingStart(WINDOW, NOW, 0)).toEqual(WINDOW);
  });
});

describe("selectRuns", () => {
  it("keeps every run inside the window, whatever its attempt", () => {
    const inWindow = [run(1, "2026-06-23T01:00:00Z"), run(2, "2026-06-23T02:00:00Z", 3)];
    expect(selectRuns(inWindow, WINDOW, { "2": 3 })).toEqual({ runs: inWindow, reruns: 0 });
  });

  it("keeps an older run only when it has an attempt newer than the one collected", () => {
    const fresh = run(10, "2026-06-20T00:00:00Z", 2);
    const seen = run(11, "2026-06-20T00:00:00Z", 2);
    const newer = run(12, "2026-06-20T00:00:00Z", 3);
    const untouched = run(13, "2026-06-20T00:00:00Z");

    const { runs, reruns } = selectRuns([fresh, seen, newer, untouched], WINDOW, {
      "11": 2,
      "12": 2,
    });

    expect(runs.map((r) => r.run_id)).toEqual([10, 12]);
    expect(reruns).toBe(2);
  });
});

describe("selectRuns with tracked pending runs", () => {
  it("keeps a listed pending run from before the window so it needs no separate fetch", () => {
    const pending = run(20, "2026-06-20T00:00:00Z");
    expect(selectRuns([pending], WINDOW, {}, [20]).runs).toEqual([pending]);
  });
});

describe("nextCollectedAttempts", () => {
  it("records processed re-runs and drops runs that fell out of the listing", () => {
    const listed = [run(1, "2026-06-20T00:00:00Z", 2), run(2, "2026-06-21T00:00:00Z", 3)];
    const next = nextCollectedAttempts({ "1": 2, "99": 4 }, listed, [listed[1] as WorkflowRun]);
    expect(next).toEqual({ "1": 2, "2": 3 });
  });

  it("never records first attempts or lowers a recorded attempt", () => {
    const listed = [run(1, "2026-06-20T00:00:00Z"), run(2, "2026-06-21T00:00:00Z", 2)];
    expect(nextCollectedAttempts({ "2": 3 }, listed, listed)).toEqual({ "2": 3 });
  });
});

describe("initialCollectedAttempts", () => {
  const older = [
    { ...run(1, "2026-06-20T00:00:00Z", 2), run_started_at: "2026-06-21T00:00:00Z" },
    run(2, "2026-06-20T00:00:00Z"),
  ];
  const inWindow = run(3, "2026-06-23T01:00:00Z", 2);
  const LAST = "2026-06-22T00:00:00Z";

  it("uses the recorded attempts once a repo tracks re-runs", () => {
    const previous = {
      pending_runs: [],
      watermark: "2026-06-23T00:00:00Z",
      last_collected_at: LAST,
      rerun_attempts: {},
    };
    expect(initialCollectedAttempts(previous, [...older, inWindow], WINDOW)).toEqual({});
  });

  it("takes an upgraded repo's older re-runs as already collected", () => {
    const previous = {
      pending_runs: [],
      watermark: "2026-06-23T00:00:00Z",
      last_collected_at: LAST,
    };
    const seeded = initialCollectedAttempts(previous, [...older, inWindow], WINDOW);
    expect(seeded).toEqual({ "1": 2 });
    expect(selectRuns([...older, inWindow], WINDOW, seeded).reruns).toBe(0);
  });

  it("leaves a re-run that started after the last collect to be collected", () => {
    const previous = {
      pending_runs: [],
      watermark: "2026-06-23T00:00:00Z",
      last_collected_at: LAST,
    };
    const later = { ...run(4, "2026-06-20T00:00:00Z", 2), run_started_at: "2026-06-22T06:00:00Z" };
    const unknown = run(5, "2026-06-20T00:00:00Z", 2);
    const seeded = initialCollectedAttempts(previous, [later, unknown], WINDOW);
    expect(seeded).toEqual({});
    expect(selectRuns([later, unknown], WINDOW, seeded).reruns).toBe(2);
  });

  it("seeds nothing for a repo that was never collected", () => {
    expect(initialCollectedAttempts({ pending_runs: [] }, older, WINDOW)).toEqual({});
  });
});

describe("alreadyCollectedAttempt", () => {
  it("is none for a run in the window or a tracked pending run", () => {
    expect(alreadyCollectedAttempt(run(1, "2026-06-23T01:00:00Z", 2), WINDOW, {}, [])).toBe(0);
    expect(alreadyCollectedAttempt(run(2, "2026-06-20T00:00:00Z", 2), WINDOW, {}, [2])).toBe(0);
  });

  it("is the recorded attempt, default 1, for a re-run from the lookback stretch", () => {
    expect(alreadyCollectedAttempt(run(3, "2026-06-20T00:00:00Z", 3), WINDOW, {}, [])).toBe(1);
    expect(alreadyCollectedAttempt(run(4, "2026-06-20T00:00:00Z", 3), WINDOW, { "4": 2 }, [])).toBe(
      2,
    );
  });
});
