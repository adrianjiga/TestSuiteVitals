import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArtifactFetcher, fetchReportArtifacts } from "../src/artifacts/fetch.js";
import type { ArtifactMeta } from "../src/github/artifacts.js";
import type { WorkflowRun } from "../src/github/runs.js";

function run(id: number): WorkflowRun {
  return {
    run_id: id,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    workflow: "ci.yml",
    branch: "main",
    sha: "abc",
    trigger: "push",
    created_at: "2026-06-23T10:00:00Z",
  };
}

function artifact(id: number, name: string, expired = false): ArtifactMeta {
  return { id, name, size_bytes: 100, expired };
}

const reportZip = zipSync({ "junit.xml": strToU8("<testsuites/>") });

describe("fetchReportArtifacts", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "suitevitals-fetch-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("downloads only report matches and extracts their files", async () => {
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => [
        artifact(10, "playwright-report"),
        artifact(11, "videos"),
        artifact(12, "old-report", true),
      ]),
      download: vi.fn(async () => reportZip),
    };

    const { summary, reports } = await fetchReportArtifacts(fetcher, [run(1)], workdir);

    expect(fetcher.download).toHaveBeenCalledTimes(1);
    expect(fetcher.download).toHaveBeenCalledWith(10);
    expect(summary.reportArtifacts).toBe(1);
    expect(summary.expiredArtifacts).toBe(1);
    expect(summary.runsWithExpired).toBe(1);
    expect(summary.skippedArtifacts).toBe(1);
    expect(summary.filesExtracted).toBe(1);
    expect(reports).toHaveLength(1);
  });

  it("dry-run counts what would be fetched but downloads nothing", async () => {
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => [artifact(10, "junit-report")]),
      download: vi.fn(async () => reportZip),
    };

    const { summary, reports } = await fetchReportArtifacts(fetcher, [run(1)], workdir, {
      dryRun: true,
    });

    expect(fetcher.download).not.toHaveBeenCalled();
    expect(summary.reportArtifacts).toBe(1);
    expect(summary.filesExtracted).toBe(0);
    expect(reports).toHaveLength(0);
  });

  it("aggregates across multiple runs", async () => {
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => [artifact(10, "report")]),
      download: vi.fn(async () => reportZip),
    };

    const { summary } = await fetchReportArtifacts(fetcher, [run(1), run(2)], workdir);

    expect(summary.runsScanned).toBe(2);
    expect(summary.filesExtracted).toBe(2);
  });
});
