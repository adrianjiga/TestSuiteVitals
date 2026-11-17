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
  /** When the latest attempt started. */
  run_started_at?: string;
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
    ...(run.run_started_at ? { run_started_at: run.run_started_at } : {}),
  };
}

/** GitHub returns at most this many results for a `created`-filtered run listing. */
export const RUN_LISTING_CAP = 1000;

/** One `created` range's runs, or `complete: false` when it matched more than the cap. */
export type RangeListing = { complete: true; runs: WorkflowRun[] } | { complete: false };

/** Lists the runs created within `[start, end]` (both inclusive). */
export type RangeLister = (start: Date, end: Date) => Promise<RangeListing>;

/**
 * Lists every run created in `[since, until]`, newest first, halving any range that matches more
 * than {@link RUN_LISTING_CAP} runs until each slice fits. Ranges are inclusive at both ends, so a
 * run on a split boundary is de-duped by id.
 */
export async function listRunsWindowed(
  listRange: RangeLister,
  since: Date,
  until: Date,
): Promise<WorkflowRun[]> {
  const byId = new Map<number, WorkflowRun>();
  const ranges: Array<[Date, Date]> = [[since, until]];
  for (let range = ranges.pop(); range; range = ranges.pop()) {
    const [start, end] = range;
    const listing = await listRange(start, end);
    if (listing.complete) {
      for (const run of listing.runs) {
        byId.set(run.run_id, run);
      }
      continue;
    }
    const mid = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2));
    if (mid.getTime() <= start.getTime()) {
      throw new Error(
        `More than ${RUN_LISTING_CAP} runs were created at ${start.toISOString()}; cannot list them all.`,
      );
    }
    ranges.push([start, mid], [mid, end]);
  }
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Lists workflow runs created in `[since, until]`, newest first, past GitHub's listing cap. */
export function listRunsSince(
  octokit: Octokit,
  ref: RepoRef,
  since: Date,
  until: Date,
): Promise<WorkflowRun[]> {
  return listRunsWindowed((start, end) => listRunRange(octokit, ref, start, end), since, until);
}

async function listRunRange(
  octokit: Octokit,
  ref: RepoRef,
  start: Date,
  end: Date,
): Promise<RangeListing> {
  const runs: WorkflowRun[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.actions.listWorkflowRunsForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    created: `${start.toISOString()}..${end.toISOString()}`,
    per_page: 100,
  });
  for await (const { data } of iterator) {
    const total = (data as { total_count?: number }).total_count ?? 0;
    if (total > RUN_LISTING_CAP) {
      return { complete: false };
    }
    runs.push(...data.map(normalize));
  }
  return { complete: true, runs };
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
 * Start times of every attempt of `run`, oldest first: attempt 1 starts at the run's creation,
 * and each later attempt costs one request.
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

/** The attempt that uploaded an artifact: the latest one that had started when it was created. */
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
