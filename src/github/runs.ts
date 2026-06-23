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

function normalize(run: ListedRun): WorkflowRun {
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

/** Splits runs into completed (collectable) and pending (in-progress/queued). */
export function classifyRuns(runs: WorkflowRun[]): ClassifiedRuns {
  const completed: WorkflowRun[] = [];
  const pending: WorkflowRun[] = [];
  for (const run of runs) {
    (run.status === COMPLETED ? completed : pending).push(run);
  }
  return { completed, pending };
}
