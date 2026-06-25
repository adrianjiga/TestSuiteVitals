import { join } from "node:path";
import { type ArtifactMeta, partitionArtifacts } from "../github/artifacts.js";
import type { WorkflowRun } from "../github/runs.js";
import { extractZipNested } from "./extract.js";

/** The two artifact operations the fetcher needs; injectable so the orchestration is testable. */
export interface ArtifactFetcher {
  list(runId: number): Promise<ArtifactMeta[]>;
  download(artifactId: number): Promise<Uint8Array>;
}

/** Extracted report files for a single run. */
export interface RunReports {
  run: WorkflowRun;
  files: string[];
}

export interface ArtifactFetchSummary {
  runsScanned: number;
  artifactsSeen: number;
  reportArtifacts: number;
  filesExtracted: number;
  expiredArtifacts: number;
  runsWithExpired: number;
  skippedArtifacts: number;
}

export interface ArtifactFetchResult {
  summary: ArtifactFetchSummary;
  reports: RunReports[];
}

export interface ArtifactFetchOptions {
  /** List and partition artifacts to report what would be fetched, but download nothing. */
  dryRun?: boolean;
  /** Called after each run is processed, for live progress (done of total). */
  onProgress?: (done: number, total: number) => void;
}

function emptySummary(): ArtifactFetchSummary {
  return {
    runsScanned: 0,
    artifactsSeen: 0,
    reportArtifacts: 0,
    filesExtracted: 0,
    expiredArtifacts: 0,
    runsWithExpired: 0,
    skippedArtifacts: 0,
  };
}

/**
 * For each run: list artifacts (D9 tier 1), partition them, download the report-glob
 * matches (tier 2), and extract each into `workdir/<run_id>/<artifact_id>/`. Expired
 * artifacts are counted, never silently dropped. Runs sequentially; concurrency is
 * deferred to M2.
 */
export async function fetchReportArtifacts(
  fetcher: ArtifactFetcher,
  runs: WorkflowRun[],
  workdir: string,
  options: ArtifactFetchOptions = {},
): Promise<ArtifactFetchResult> {
  const { dryRun = false, onProgress } = options;
  const summary = emptySummary();
  const reports: RunReports[] = [];

  for (const run of runs) {
    summary.runsScanned++;
    onProgress?.(summary.runsScanned, runs.length);

    const artifacts = await fetcher.list(run.run_id);
    summary.artifactsSeen += artifacts.length;

    const partition = partitionArtifacts(artifacts);
    summary.reportArtifacts += partition.reports.length;
    summary.expiredArtifacts += partition.expired.length;
    summary.skippedArtifacts += partition.skipped.length;
    if (partition.expired.length > 0) {
      summary.runsWithExpired++;
    }

    if (dryRun) {
      continue;
    }

    const files: string[] = [];
    for (const artifact of partition.reports) {
      const zip = await fetcher.download(artifact.id);
      const dest = join(workdir, String(run.run_id), String(artifact.id));
      files.push(...(await extractZipNested(zip, dest)));
    }

    summary.filesExtracted += files.length;
    if (files.length > 0) {
      reports.push({ run, files });
    }
  }

  return { summary, reports };
}
