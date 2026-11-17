import { describe, expect, it } from "vitest";
import {
  type ArtifactMeta,
  matchesReportArtifact,
  partitionArtifacts,
} from "../src/github/artifacts.js";

function artifact(overrides: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    id: 1,
    name: "artifact",
    size_bytes: 100,
    created_at: "2026-06-23T10:05:00Z",
    expired: false,
    ...overrides,
  };
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

  it("excludes by glob before any other tier, so a roll-up is never downloaded", () => {
    // A pipeline that uploads per-cell reports *and* a merged roll-up would otherwise count
    // every test twice — once under its real cell, once under the roll-up.
    const result = partitionArtifacts(
      [
        artifact({ id: 1, name: "cypress-results-ui-chrome-desktop" }),
        artifact({ id: 2, name: "final-test-report" }),
      ],
      ["final-test-report"],
    );

    expect(result.reports.map((a) => a.id)).toEqual([1]);
    expect(result.excluded.map((a) => a.id)).toEqual([2]);
    expect(result.skipped).toHaveLength(0);
  });

  it("excludes an artifact even when it is expired or a report match", () => {
    // Exclusion is the caller's explicit intent, so it wins over every other classification.
    const result = partitionArtifacts(
      [artifact({ id: 1, name: "junit-results", expired: true })],
      ["junit-*"],
    );
    expect(result.excluded.map((a) => a.id)).toEqual([1]);
    expect(result.expired).toHaveLength(0);
  });

  it("leaves everything alone when no globs are given", () => {
    const result = partitionArtifacts([artifact({ name: "blob-report" })]);
    expect(result.excluded).toHaveLength(0);
    expect(result.reports).toHaveLength(1);
  });
});
