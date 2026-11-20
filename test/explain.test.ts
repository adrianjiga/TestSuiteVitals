import { describe, expect, it } from "vitest";
import type { TestAggregate } from "../src/report/aggregate.js";
import { explainScore } from "../src/report/explain.js";
import { scoreTest } from "../src/report/score.js";
import { withWeights } from "./helpers/aggregates.js";

function agg(over: Partial<TestAggregate> = {}): TestAggregate {
  return withWeights({
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
    flips: 0,
    flipPairs: 0,
    distinctShas: 0,
    intermittentShas: 0,
    fingerprints: 0,
    firstSeen: "2026-06-01T00:00:00Z",
    lastSeen: "2026-06-01T00:00:00Z",
    ...over,
  });
}

function reason(over: Partial<TestAggregate>): string {
  const aggregate = agg(over);
  return explainScore(aggregate, scoreTest(aggregate));
}

describe("explainScore", () => {
  it("is empty when nothing contributes", () => {
    expect(reason({ passed: 10, distinctShas: 10 })).toBe("");
  });

  it("names the top contributor with the counts behind it", () => {
    expect(reason({ passed: 10, flakyRuns: 3, distinctShas: 10 })).toBe("3 retry-passes");
    expect(reason({ passed: 10, flakyRuns: 1, distinctShas: 10 })).toBe("1 retry-pass");
    expect(reason({ passed: 30, failed: 10, flips: 9, flipPairs: 39 })).toBe("flips 9/39");
    expect(reason({ passed: 5, failed: 5, distinctShas: 31, intermittentShas: 2 })).toBe(
      "pass+fail on 2/31 commits",
    );
    expect(reason({ failed: 10, distinctShas: 10, fingerprints: 3 })).toBe("3 failure modes");
  });

  it("picks the signal worth the most points, not the highest rate", () => {
    // Intermittence 50% × 0.20 = 10 points beats diversity 33% × 0.15 = 5 points.
    const both = { passed: 5, failed: 5, distinctShas: 10, intermittentShas: 5, fingerprints: 2 };
    expect(reason(both)).toBe("pass+fail on 5/10 commits");
  });
});
