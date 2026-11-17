import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./repo.js";

/** A workflow run reduced to the fields the collector cares about. */
export interface WorkflowRun {
  run_id: number;
  run_attempt: number;
  /** GitHub run lifecycle: "completed", "in_progress", "queued", etc. */
  status: string;
  /** Result once completed: "success", "failure", null while running. */
  conclusion: string | null;
  workflow: string;
  branch: string | null;
  sha: string;
  trigger: string;
  created_at: string;
}

/** Runs split by whether they are safe to collect now (D12). */
export interface ClassifiedRuns {
  /** Completed runs — artifacts are final and collectable. */
  completed: WorkflowRun[];
  /** In-progress/queued runs — re-check next time; the watermark must not pass them. */
  pending: WorkflowRun[];
}

const COMPLETED = "completed";

type ListedRun = Awaited<
  ReturnType<Octokit["rest"]["actions"]["listWorkflowRunsForRepo"]>
>["data"]["workflow_runs"][number];

type FetchedRun = Awaited<ReturnType<Octokit["rest"]["actions"]["getWorkflowRun"]>>["data"];

function normalize(run: ListedRun | FetchedRun): WorkflowRun {
  return {
    run_id: run.id,
    run_attempt: run.run_attempt ?? 1,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    workflow: run.name ?? String(run.workflow_id),
    branch: run.head_branch,
    sha: run.head_sha,
    trigger: run.event,
    created_at: run.created_at,
  };
}

/**
 * Lists workflow runs created at or after `since`, newest-first. Streams pages and
 * stops as soon as a run older than `since` is seen — the API is already filtered by
 * `created`, but the explicit break avoids fetching pages we would discard.
 */
export async function listRunsSince(
  octokit: Octokit,
  ref: RepoRef,
  since: Date,
): Promise<WorkflowRun[]> {
  const sinceMs = since.getTime();
  const runs: WorkflowRun[] = [];

  const iterator = octokit.paginate.iterator(octokit.rest.actions.listWorkflowRunsForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    created: `>=${since.toISOString()}`,
    per_page: 100,
  });

  for await (const { data } of iterator) {
    for (const run of data) {
      if (new Date(run.created_at).getTime() < sinceMs) {
        return runs;
      }
      runs.push(normalize(run));
    }
  }

  return runs;
}

/** Fetches a single workflow run by id — the D12 pending-run re-check path. */
export async function getRun(octokit: Octokit, ref: RepoRef, runId: number): Promise<WorkflowRun> {
  const { data } = await octokit.rest.actions.getWorkflowRun({
    owner: ref.owner,
    repo: ref.repo,
    run_id: runId,
  });
  return normalize(data);
}

/**
 * Start times of every attempt of `run`, oldest first (index 0 is attempt 1). Attempt 1 starts
 * when the run was created; later attempts are fetched one call each, so a run that was never
 * re-run costs no extra requests.
 */
export async function listAttemptStarts(
  octokit: Octokit,
  ref: RepoRef,
  run: WorkflowRun,
): Promise<string[]> {
  const starts = [run.created_at];
  for (let attempt = 2; attempt <= run.run_attempt; attempt++) {
    const { data } = await octokit.rest.actions.getWorkflowRunAttempt({
      owner: ref.owner,
      repo: ref.repo,
      run_id: run.run_id,
      attempt_number: attempt,
    });
    starts.push(data.run_started_at ?? data.created_at);
  }
  return starts;
}

/**
 * The attempt an artifact belongs to: the latest attempt that had started when the artifact was
 * created. A partial re-run carries the untouched jobs' artifacts over from earlier attempts, so
 * the run's current `run_attempt` would mislabel them and double-count every carried-over test
 * under a second dedup key.
 */
export function attemptForArtifact(createdAt: string, attemptStarts: string[]): number {
  let attempt = 1;
  for (let i = 1; i < attemptStarts.length; i++) {
    const start = attemptStarts[i];
    if (start !== undefined && start <= createdAt) {
      attempt = i + 1;
    }
  }
  return attempt;
}

/**
 * Tracked pending-run ids that the window listing did not surface — runs created before the
 * window start whose completion the `created`-filtered listing can never see (D12). These are
 * re-fetched by id so the watermark passing them never loses them.
 */
export function missingPendingIds(pendingIds: number[], listed: WorkflowRun[]): number[] {
  const seen = new Set(listed.map((run) => run.run_id));
  return pendingIds.filter((id) => !seen.has(id));
}

/** Splits runs into completed (collectable) and pending (in-progress/queued). */
export function classifyRuns(runs: WorkflowRun[]): ClassifiedRuns {
  const completed: WorkflowRun[] = [];
  const pending: WorkflowRun[] = [];
  for (const run of runs) {
    (run.status === COMPLETED ? completed : pending).push(run);
  }
  return { completed, pending };
}
