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

  it("never runs more than `concurrency` listings in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return [];
      }),
      download: vi.fn(async () => reportZip),
    };

    const runs = Array.from({ length: 8 }, (_, i) => run(i + 1));
    await fetchReportArtifacts(fetcher, runs, workdir, { concurrency: 3 });

    expect(peak).toBe(3);
    expect(fetcher.list).toHaveBeenCalledTimes(8);
  });

  it("folds results in input order even when downloads finish out of order", async () => {
    // Each run's sole artifact id == its run id. Run 1's download is the slowest, so it
    // finishes last — yet the reports array must still be ordered by the input runs.
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async (runId: number) => [artifact(runId, "report")]),
      download: vi.fn(async (id: number) => {
        await new Promise((resolve) => setTimeout(resolve, (4 - id) * 10));
        return reportZip;
      }),
    };

    const { reports, summary } = await fetchReportArtifacts(
      fetcher,
      [run(1), run(2), run(3)],
      workdir,
      { concurrency: 3 },
    );

    expect(reports.map((r) => r.run.run_id)).toEqual([1, 2, 3]);
    expect(summary.runsScanned).toBe(3);
    expect(summary.filesExtracted).toBe(3);
  });

  it("reports progress once per run", async () => {
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => []),
      download: vi.fn(async () => reportZip),
    };
    const onProgress = vi.fn();

    await fetchReportArtifacts(fetcher, [run(1), run(2), run(3)], workdir, { onProgress });

    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("sniffs unnamed artifacts (tier 3) only when a run has no name match", async () => {
    const fetcher: ArtifactFetcher = {
      // No report-name match — the report is uploaded as "test-output".
      list: vi.fn(async () => [artifact(20, "test-output"), artifact(21, "screenshots")]),
      download: vi.fn(async () => reportZip),
    };

    const { summary, reports } = await fetchReportArtifacts(fetcher, [run(1)], workdir);

    expect(summary.reportArtifacts).toBe(0);
    expect(summary.sniffedArtifacts).toBe(2);
    expect(summary.skippedArtifacts).toBe(0);
    expect(fetcher.download).toHaveBeenCalledTimes(2);
    expect(reports).toHaveLength(1);
  });

  it("does not sniff when a name match exists — skipped artifacts stay un-downloaded", async () => {
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => [artifact(30, "junit-report"), artifact(31, "videos")]),
      download: vi.fn(async () => reportZip),
    };

    const { summary } = await fetchReportArtifacts(fetcher, [run(1)], workdir);

    expect(summary.reportArtifacts).toBe(1);
    expect(summary.sniffedArtifacts).toBe(0);
    expect(summary.skippedArtifacts).toBe(1);
    expect(fetcher.download).toHaveBeenCalledTimes(1); // only the named report
  });

  it("skips oversized sniff candidates and reports them, never silently", async () => {
    const big = { id: 40, name: "huge-bundle", size_bytes: 200 * 1024 * 1024, expired: false };
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => [big, artifact(41, "small-output")]),
      download: vi.fn(async () => reportZip),
    };

    const { summary } = await fetchReportArtifacts(fetcher, [run(1)], workdir, {
      maxArtifactMb: 100,
    });

    expect(summary.sniffedArtifacts).toBe(1); // only the small one
    expect(summary.oversizedArtifacts).toBe(1); // the 200 MB bundle, surfaced not dropped
    expect(fetcher.download).toHaveBeenCalledTimes(1);
    expect(fetcher.download).toHaveBeenCalledWith(41);
  });

  it("counts a zip bomb as oversized and keeps collecting the run's other artifacts", async () => {
    // A tiny compressed zip declaring 2 MB uncompressed; extraction budget throws on it. The
    // GitHub-reported size_bytes is small, so only the extraction-time guard can catch it.
    const bomb = zipSync({ "huge.bin": new Uint8Array(2 * 1024 * 1024) });
    const fetcher: ArtifactFetcher = {
      list: vi.fn(async () => [artifact(50, "bomb-report"), artifact(51, "junit-report")]),
      download: vi.fn(async (id: number) => (id === 50 ? bomb : reportZip)),
    };

    const { summary, reports } = await fetchReportArtifacts(fetcher, [run(1)], workdir, {
      maxExtractMb: 1,
    });

    expect(summary.oversizedArtifacts).toBe(1); // the bomb, surfaced not fatal
    expect(summary.filesExtracted).toBe(1); // the healthy report still landed
    expect(reports).toHaveLength(1);
  });
});
