import { join } from "node:path";
import pLimit from "p-limit";
import { type ArtifactMeta, partitionArtifacts } from "../github/artifacts.js";
import type { WorkflowRun } from "../github/runs.js";
import { extractZipNested } from "./extract.js";

/** Default number of runs fetched in parallel; balances throughput against rate limits. */
export const DEFAULT_CONCURRENCY = 5;

/** Default size ceiling (MB) for tier-3 sniffing, so failure videos/traces never dominate (D9). */
export const DEFAULT_MAX_ARTIFACT_MB = 100;

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
  /** Non-report artifacts examined by content sniff because the run had no name match (D9 tier 3). */
  sniffedArtifacts: number;
  /** Sniff candidates skipped for exceeding the size cap — surfaced, never silently dropped. */
  oversizedArtifacts: number;
  /** Non-report artifacts left un-examined (a name match existed, so tier-3 did not run). */
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
  /** Size ceiling (MB) for tier-3 sniff candidates. Defaults to {@link DEFAULT_MAX_ARTIFACT_MB}. */
  maxArtifactMb?: number;
}

/** What one run contributed, computed in isolation so runs can be fetched in parallel. */
interface RunOutcome {
  run: WorkflowRun;
  artifactsSeen: number;
  reportArtifacts: number;
  expiredArtifacts: number;
  sniffedArtifacts: number;
  oversizedArtifacts: number;
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
    sniffedArtifacts: 0,
    oversizedArtifacts: 0,
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
  const {
    dryRun = false,
    onProgress,
    concurrency = DEFAULT_CONCURRENCY,
    maxArtifactMb = DEFAULT_MAX_ARTIFACT_MB,
  } = options;
  const limit = pLimit(Math.max(1, concurrency));
  const maxArtifactBytes = maxArtifactMb * 1024 * 1024;

  let completed = 0;
  const outcomes = await Promise.all(
    runs.map((run) =>
      limit(async () => {
        const outcome = await fetchRun(fetcher, run, workdir, dryRun, maxArtifactBytes);
        completed++;
        onProgress?.(completed, runs.length);
        return outcome;
      }),
    ),
  );

  return foldOutcomes(outcomes);
}

/**
 * Fetches and extracts one run's artifacts in isolation (no shared state). Tier 2 downloads the
 * report-name matches. Tier 3 (D9): only when a run has *no* name match, the remaining artifacts
 * under the size cap are downloaded and extracted too, so a report uploaded under an unexpected
 * name is still found — the content sniff in the parse step discards anything that is not a report.
 * Oversized sniff candidates are counted and reported, never silently dropped.
 */
async function fetchRun(
  fetcher: ArtifactFetcher,
  run: WorkflowRun,
  workdir: string,
  dryRun: boolean,
  maxArtifactBytes: number,
): Promise<RunOutcome> {
  const artifacts = await fetcher.list(run.run_id);
  const partition = partitionArtifacts(artifacts);

  // Tier 3 runs only when no report-name match was found for this run.
  const sniffRun = partition.reports.length === 0;
  const toSniff: ArtifactMeta[] = [];
  let oversized = 0;
  if (sniffRun) {
    for (const artifact of partition.skipped) {
      if (artifact.size_bytes > maxArtifactBytes) {
        oversized++;
      } else {
        toSniff.push(artifact);
      }
    }
  }

  const files: string[] = [];
  if (!dryRun) {
    for (const artifact of [...partition.reports, ...toSniff]) {
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
    sniffedArtifacts: toSniff.length,
    oversizedArtifacts: oversized,
    // When tier-3 ran, the skipped bucket was examined (sniffed/oversized); otherwise it is left alone.
    skippedArtifacts: sniffRun ? 0 : partition.skipped.length,
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
    summary.sniffedArtifacts += outcome.sniffedArtifacts;
    summary.oversizedArtifacts += outcome.oversizedArtifacts;
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
