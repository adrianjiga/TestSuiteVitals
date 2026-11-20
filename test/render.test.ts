import { describe, expect, it } from "vitest";
import { createPalette } from "../src/colors.js";
import type { TestAggregate } from "../src/report/aggregate.js";
import { rankTests } from "../src/report/rank.js";
import { renderReport, renderReportJson } from "../src/report/render.js";

function agg(id: string, over: Partial<TestAggregate> = {}): TestAggregate {
  return {
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
  };
}

const ranked = rankTests([
  agg("flaky", { passed: 10, flakyRuns: 10, distinctShas: 10 }),
  agg("stable", { passed: 10, distinctShas: 10 }),
  agg("tiny", { passed: 2, failed: 1, distinctShas: 3 }),
]);

describe("renderReport", () => {
  it("neutralizes terminal escapes smuggled in through a test title", () => {
    const hostile = rankTests([
      agg("t", {
        title_path: ["A", "\u001b[2J\u001b[Hall tests passed"],
        passed: 5,
        distinctShas: 5,
      }),
    ]);
    const out = renderReport(hostile, { slug: "o/r", totalTests: 1 }, { limit: 20, all: false });
    expect(out).not.toContain("\u001b");
    expect(out).toContain("\uFFFD[2J\uFFFD[Hall tests passed");
  });

  it("shows a header, ranked rows in score order, and a hidden-count footer", () => {
    const out = renderReport(ranked, { slug: "o/r", totalTests: 3 }, { limit: 20, all: false });
    expect(out).toContain("Flaky tests · o/r · 3 tests");
    expect(out.indexOf("flaky")).toBeLessThan(out.indexOf("stable"));
    expect(out).toContain("1 test(s) below the min-runs threshold hidden (--all to show).");
    expect(out).not.toContain("tiny");
  });

  it("reveals below-threshold tests with --all", () => {
    const out = renderReport(ranked, { slug: "o/r", totalTests: 3 }, { limit: 20, all: true });
    expect(out).toContain("Below the min-runs threshold (1):");
    expect(out).toContain("tiny");
  });

  it("limits the number of ranked rows shown", () => {
    const out = renderReport(ranked, { slug: "o/r", totalTests: 3 }, { limit: 1, all: false });
    expect(out).toContain("flaky");
    expect(out).not.toContain("› stable");
  });

  it("stays plain by default and applies ANSI codes with an enabled palette", () => {
    const plain = renderReport(ranked, { slug: "o/r", totalTests: 3 }, { limit: 20, all: false });
    expect(plain).not.toContain("[");

    const colored = renderReport(
      ranked,
      { slug: "o/r", totalTests: 3 },
      { limit: 20, all: false },
      createPalette(true),
    );
    expect(colored).toContain("[");
  });
});

describe("renderReportJson", () => {
  it("emits eligible tests first with score fields, parseable as JSON", () => {
    const rows = JSON.parse(renderReportJson(ranked)) as Array<{ id: string; eligible: boolean }>;
    expect(rows.map((r) => r.id)).toEqual(["flaky", "stable", "tiny"]);
    expect(rows[0]).toMatchObject({ id: "flaky", score: 35, eligible: true });
    expect(rows.at(-1)).toMatchObject({ id: "tiny", eligible: false });
  });
});
