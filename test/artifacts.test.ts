import { describe, expect, it } from "vitest";
import {
  type ArtifactMeta,
  matchesReportArtifact,
  partitionArtifacts,
} from "../src/github/artifacts.js";

function artifact(overrides: Partial<ArtifactMeta>): ArtifactMeta {
  return { id: 1, name: "artifact", size_bytes: 100, expired: false, ...overrides };
}

describe("matchesReportArtifact", () => {
  it.each([
    "playwright-report",
    "blob-report",
    "junit-results",
    "mochawesome-report",
    "test-RESULTS",
  ])("matches %j", (name) => {
    expect(matchesReportArtifact(name)).toBe(true);
  });

  it.each(["videos", "traces", "screenshots", "coverage"])("does not match %j", (name) => {
    expect(matchesReportArtifact(name)).toBe(false);
  });
});

describe("partitionArtifacts", () => {
  it("splits into reports, expired, and skipped", () => {
    const result = partitionArtifacts([
      artifact({ id: 1, name: "playwright-report" }),
      artifact({ id: 2, name: "videos" }),
      artifact({ id: 3, name: "junit-results", expired: true }),
    ]);

    expect(result.reports.map((a) => a.id)).toEqual([1]);
    expect(result.skipped.map((a) => a.id)).toEqual([2]);
    expect(result.expired.map((a) => a.id)).toEqual([3]);
  });

  it("counts an expired report match as expired, not downloadable", () => {
    const result = partitionArtifacts([artifact({ name: "blob-report", expired: true })]);
    expect(result.reports).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
  });
});
