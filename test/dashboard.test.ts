import { describe, expect, it } from "vitest";
import type { RunOutcome, TestAggregate } from "../src/report/aggregate.js";
import { renderDashboard } from "../src/report/dashboard.js";
import { rankTests } from "../src/report/rank.js";
import { withWeights } from "./helpers/aggregates.js";

function agg(id: string, over: Partial<TestAggregate> = {}): TestAggregate {
  return withWeights({
    id,
    file: "e2e/app.spec.js",
    title_path: ["App", id],
    framework: "playwright",
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
    lastSeen: "2026-06-02T00:00:00Z",
    ...over,
  });
}

const meta = { slug: "owner/repo", totalTests: 1, generatedAt: "2026-06-28T00:00:00Z" };

describe("renderDashboard", () => {
  it("renders a self-contained HTML document with the repo and a ranked, tinted row", () => {
    const timeline: RunOutcome[] = ["passed", "flaky", "failed"];
    const ranked = rankTests([
      agg("flaky", { passed: 10, flakyRuns: 10, distinctShas: 10, timeline }),
    ]);
    const html = renderDashboard(ranked, meta);

    expect(html).toContain("<!doctype html>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<style>"); // inline CSS, self-contained
    expect(html).toContain("SUITEVITALS");
    expect(html).toContain("owner/repo");
    expect(html).toContain("sev-mid"); // raw 35 × confidence 10/15 → 23, unstable tint
    expect(html).toContain("background:var(--bad)"); // the failed sparkline bar
    expect(html).toContain('<span class="why">10 retry-passes</span>');
  });

  it("escapes HTML in test identifiers", () => {
    const ranked = rankTests([
      agg("x", { passed: 8, distinctShas: 8, file: "<script>", title_path: ["A & B"] }),
    ]);
    const html = renderDashboard(ranked, meta);

    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain("<script>");
  });

  it("shows an all-stable message and a below-threshold section", () => {
    const ranked = rankTests([agg("tiny", { passed: 2, failed: 1, distinctShas: 3 })]);
    const html = renderDashboard(ranked, meta);

    expect(html).toContain("all vitals stable");
    expect(html).toContain("Below the min-runs threshold (1)");
  });
});
