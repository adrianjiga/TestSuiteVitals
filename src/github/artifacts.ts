import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./repo.js";

/** A run artifact reduced to the fields tiered discovery (D9) needs. */
export interface ArtifactMeta {
  id: number;
  name: string;
  size_bytes: number;
  /** GitHub has purged the blob (retention elapsed); it can no longer be downloaded. */
  expired: boolean;
}

/**
 * Substrings that mark an artifact as a likely test report (D9 tier 2). Matched
 * case-insensitively against the artifact name; e.g. `playwright-report`,
 * `junit-results`, `blob-report`, `mochawesome-report`.
 */
export const REPORT_NAME_PATTERNS = ["report", "result", "junit", "blob", "mochawesome"] as const;

/** True if an artifact name looks like a test report worth downloading. */
export function matchesReportArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  return REPORT_NAME_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Artifacts split by what tiered discovery should do with each (D9). */
export interface PartitionedArtifacts {
  /** Report-glob matches with a live blob — download these. */
  reports: ArtifactMeta[];
  /** Expired blobs — count for the summary; cannot be downloaded. */
  expired: ArtifactMeta[];
  /** Live non-report artifacts — tier-3 sniff candidates (deferred to M5). */
  skipped: ArtifactMeta[];
}

/**
 * Partitions a run's artifacts. Expired is checked first: an expired report match
 * still cannot be downloaded, so it belongs in the expired (reported) bucket.
 */
export function partitionArtifacts(artifacts: ArtifactMeta[]): PartitionedArtifacts {
  const reports: ArtifactMeta[] = [];
  const expired: ArtifactMeta[] = [];
  const skipped: ArtifactMeta[] = [];

  for (const artifact of artifacts) {
    if (artifact.expired) {
      expired.push(artifact);
    } else if (matchesReportArtifact(artifact.name)) {
      reports.push(artifact);
    } else {
      skipped.push(artifact);
    }
  }

  return { reports, expired, skipped };
}

type ListedArtifact = Awaited<
  ReturnType<Octokit["rest"]["actions"]["listWorkflowRunArtifacts"]>
>["data"]["artifacts"][number];

function normalize(artifact: ListedArtifact): ArtifactMeta {
  return {
    id: artifact.id,
    name: artifact.name,
    size_bytes: artifact.size_in_bytes,
    expired: artifact.expired,
  };
}

/** Lists all artifacts for a workflow run (D9 tier 1 — names and sizes, no downloads). */
export async function listRunArtifacts(
  octokit: Octokit,
  ref: RepoRef,
  runId: number,
): Promise<ArtifactMeta[]> {
  const artifacts = await octokit.paginate(octokit.rest.actions.listWorkflowRunArtifacts, {
    owner: ref.owner,
    repo: ref.repo,
    run_id: runId,
    per_page: 100,
  });
  return artifacts.map(normalize);
}

/** Downloads an artifact as a zip archive and returns its raw bytes. */
export async function downloadArtifactZip(
  octokit: Octokit,
  ref: RepoRef,
  artifactId: number,
): Promise<Uint8Array> {
  const response = await octokit.rest.actions.downloadArtifact({
    owner: ref.owner,
    repo: ref.repo,
    artifact_id: artifactId,
    archive_format: "zip",
  });
  return new Uint8Array(response.data as ArrayBuffer);
}
