import { describe, expect, it } from "vitest";
import type { TestAggregate } from "../src/report/aggregate.js";
import { scoreTest } from "../src/report/score.js";

/** Builds a TestAggregate with all-zero signals; override only what a case exercises. */
function agg(over: Partial<TestAggregate> = {}): TestAggregate {
  return {
    id: "t1",
    file: "a.spec.ts",
    title_path: ["A", "x"],
    framework: "junit",
    totalRuns: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flakyRuns: 0,
    retriedRuns: 0,
    rerunRuns: 0,
    flips: 0,
    flipPairs: 0,
    distinctShas: 0,
    intermittentShas: 0,
    fingerprints: 0,
    firstSeen: "2026-06-01T00:00:00Z",
    lastSeen: "2026-06-01T00:00:00Z",
    ...over,
  };
}

describe("scoreTest", () => {
  it("scores a test that always passes at zero", () => {
    const result = scoreTest(agg({ passed: 10, distinctShas: 10 }));
    expect(result.score).toBe(0);
    expect(result.eligibleRuns).toBe(10);
    expect(result.eligible).toBe(true);
  });

  it("scores a consistently-failing test at zero — broken, not flaky", () => {
    const result = scoreTest(agg({ failed: 10, distinctShas: 10, fingerprints: 1 }));
    expect(result.score).toBe(0);
  });

  it("weights pass-after-retry the heaviest (full retry-flake → 45)", () => {
    const result = scoreTest(agg({ passed: 10, flakyRuns: 10, distinctShas: 10 }));
    expect(result.signals.retryFlakeRate).toBe(1);
    expect(result.score).toBe(45);
  });

  it("counts same-commit intermittence (full intermittence → 30)", () => {
    const result = scoreTest(agg({ passed: 5, failed: 5, distinctShas: 10, intermittentShas: 10 }));
    expect(result.signals.intermittenceRate).toBe(1);
    expect(result.score).toBe(30);
  });

  it("counts only failure modes beyond the first, and caps diversity", () => {
    expect(scoreTest(agg({ failed: 1, distinctShas: 1, fingerprints: 1 })).signals.diversity).toBe(
      0,
    );
    const saturated = scoreTest(agg({ failed: 4, distinctShas: 4, fingerprints: 4 }));
    expect(saturated.signals.diversity).toBe(1);
    expect(saturated.score).toBe(15);
    // Beyond the cap the signal stays saturated.
    expect(scoreTest(agg({ failed: 9, distinctShas: 9, fingerprints: 9 })).score).toBe(15);
  });

  it("flags samples below the min-runs threshold", () => {
    const small = agg({ passed: 2, failed: 1, distinctShas: 3 });
    expect(scoreTest(small).eligible).toBe(false);
    expect(scoreTest(small, { minRuns: 3 }).eligible).toBe(true);
  });

  it("ranks a flaky test above a broken or stable one", () => {
    const flaky = scoreTest(
      agg({
        passed: 8,
        failed: 2,
        flakyRuns: 6,
        distinctShas: 10,
        intermittentShas: 3,
        fingerprints: 3,
      }),
    );
    const broken = scoreTest(agg({ failed: 10, distinctShas: 10, fingerprints: 1 }));
    const stable = scoreTest(agg({ passed: 10, distinctShas: 10 }));

    expect(flaky.score).toBeGreaterThan(broken.score);
    expect(broken.score).toBe(0);
    expect(stable.score).toBe(0);
  });
});
