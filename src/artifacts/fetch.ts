import { join } from "node:path";
import pLimit from "p-limit";
import { type ArtifactMeta, partitionArtifacts } from "../github/artifacts.js";
import type { WorkflowRun } from "../github/runs.js";
import { extractZipNested } from "./extract.js";

/** Default number of runs fetched in parallel; balances throughput against rate limits. */
export const DEFAULT_CONCURRENCY = 5;

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
  /** Max runs fetched in parallel. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
}

/** What one run contributed, computed in isolation so runs can be fetched in parallel. */
interface RunOutcome {
  run: WorkflowRun;
  artifactsSeen: number;
  reportArtifacts: number;
  expiredArtifacts: number;
  skippedArtifacts: number;
  files: string[];
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
 * artifacts are counted, never silently dropped.
 *
 * Runs are fetched up to `concurrency` at a time (p-limit), since a backfill is dozens
 * of independent, network-bound runs — the transport (client.ts) absorbs any rate-limit
 * pushback with backoff. Each run is processed into an isolated {@link RunOutcome} so the
 * parallel tasks never race on shared state; outcomes are then folded together in input
 * order, keeping the summary and `reports[]` deterministic regardless of finish order.
 */
export async function fetchReportArtifacts(
  fetcher: ArtifactFetcher,
  runs: WorkflowRun[],
  workdir: string,
  options: ArtifactFetchOptions = {},
): Promise<ArtifactFetchResult> {
  const { dryRun = false, onProgress, concurrency = DEFAULT_CONCURRENCY } = options;
  const limit = pLimit(Math.max(1, concurrency));

  let completed = 0;
  const outcomes = await Promise.all(
    runs.map((run) =>
      limit(async () => {
        const outcome = await fetchRun(fetcher, run, workdir, dryRun);
        completed++;
        onProgress?.(completed, runs.length);
        return outcome;
      }),
    ),
  );

  return foldOutcomes(outcomes);
}

/** Fetches and extracts one run's report artifacts in isolation (no shared state). */
async function fetchRun(
  fetcher: ArtifactFetcher,
  run: WorkflowRun,
  workdir: string,
  dryRun: boolean,
): Promise<RunOutcome> {
  const artifacts = await fetcher.list(run.run_id);
  const partition = partitionArtifacts(artifacts);

  const files: string[] = [];
  if (!dryRun) {
    for (const artifact of partition.reports) {
      const zip = await fetcher.download(artifact.id);
      const dest = join(workdir, String(run.run_id), String(artifact.id));
      files.push(...(await extractZipNested(zip, dest)));
    }
  }

  return {
    run,
    artifactsSeen: artifacts.length,
    reportArtifacts: partition.reports.length,
    expiredArtifacts: partition.expired.length,
    skippedArtifacts: partition.skipped.length,
    files,
  };
}

/** Folds per-run outcomes into one summary + report list, in input order. */
function foldOutcomes(outcomes: RunOutcome[]): ArtifactFetchResult {
  const summary = emptySummary();
  const reports: RunReports[] = [];

  for (const outcome of outcomes) {
    summary.runsScanned++;
    summary.artifactsSeen += outcome.artifactsSeen;
    summary.reportArtifacts += outcome.reportArtifacts;
    summary.expiredArtifacts += outcome.expiredArtifacts;
    summary.skippedArtifacts += outcome.skippedArtifacts;
    if (outcome.expiredArtifacts > 0) {
      summary.runsWithExpired++;
    }
    summary.filesExtracted += outcome.files.length;
    if (outcome.files.length > 0) {
      reports.push({ run: outcome.run, files: outcome.files });
    }
  }

  return { summary, reports };
}
