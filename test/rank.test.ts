import { describe, expect, it } from "vitest";
import type { TestAggregate } from "../src/report/aggregate.js";
import { DEFAULT_HALF_LIFE, parseHalfLife, parseSince, rankTests } from "../src/report/rank.js";
import { withWeights } from "./helpers/aggregates.js";

function agg(id: string, over: Partial<TestAggregate> = {}): TestAggregate {
  return withWeights({
    id,
    file: "a.spec.ts",
    title_path: ["A", id],
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

describe("rankTests", () => {
  it("ranks eligible tests by score and sets aside below-threshold ones", () => {
    const ranked = rankTests([
      agg("stable", { passed: 10, distinctShas: 10 }), // score 0
      agg("flaky", { passed: 10, flakyRuns: 10, distinctShas: 10 }), // score 23
      agg("intermittent", { passed: 5, failed: 5, distinctShas: 10, intermittentShas: 10 }), // 30
      agg("tiny", { passed: 2, failed: 1, distinctShas: 3 }), // 0, but only 3 runs
    ]);

    expect(ranked.eligible.map((t) => t.aggregate.id)).toEqual(["flaky", "intermittent", "stable"]);
    expect(ranked.belowThreshold.map((t) => t.aggregate.id)).toEqual(["tiny"]);
  });

  it("breaks score ties by more evidence (eligible runs)", () => {
    const ranked = rankTests([
      agg("fewer", { passed: 10, distinctShas: 10 }),
      agg("more", { passed: 25, distinctShas: 25 }),
    ]);
    expect(ranked.eligible.map((t) => t.aggregate.id)).toEqual(["more", "fewer"]);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-06-30T00:00:00Z");

  it("returns undefined when no window is given", () => {
    expect(parseSince(undefined, now)).toBeUndefined();
  });

  it("parses day and hour spans relative to now", () => {
    expect(parseSince("30d", now)?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
    expect(parseSince("12h", now)?.toISOString()).toBe("2026-06-29T12:00:00.000Z");
  });

  it("parses an absolute ISO timestamp and rejects garbage", () => {
    expect(parseSince("2026-06-01T00:00:00Z", now)?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(() => parseSince("last week", now)).toThrow(/Invalid --since/);
  });

  it("accepts a bare ISO date", () => {
    expect(parseSince("2026-06-01", now)?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("accepts a space between the date and the time", () => {
    expect(parseSince("2026-06-01 12:00Z", now)?.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    expect(parseSince("2026-06-01 12:00", now)).toBeInstanceOf(Date);
  });

  it("rejects a bare number instead of reading it as a date", () => {
    for (const value of ["7", "30", "2025", "6/1"]) {
      expect(() => parseSince(value, now)).toThrow(/Invalid --since/);
    }
  });
});

describe("parseHalfLife", () => {
  it("defaults to 14 days", () => {
    expect(DEFAULT_HALF_LIFE).toBe("14d");
    expect(parseHalfLife(undefined)).toBe(14 * 86_400_000);
  });

  it("parses day and hour spans into milliseconds", () => {
    expect(parseHalfLife("7d")).toBe(7 * 86_400_000);
    expect(parseHalfLife("12h")).toBe(12 * 3_600_000);
  });

  it("turns weighting off with `off`", () => {
    expect(parseHalfLife("off")).toBeUndefined();
  });

  it("rejects zero, ISO dates and garbage", () => {
    for (const value of ["0d", "2026-06-01", "two weeks", "14"]) {
      expect(() => parseHalfLife(value)).toThrow(/Invalid --half-life/);
    }
  });
});
