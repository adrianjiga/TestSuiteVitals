import { readFile, rename, writeFile } from "node:fs/promises";

/** Current schema version for state.json (see D11). */
export const STATE_SCHEMA_VERSION = 1;

/** Per-repo collection progress. */
export interface RepoState {
  /** ISO timestamp; collect since this point. Advances only after a durable append (D12). */
  watermark?: string;
  /** In-progress/queued run ids to re-check next collection; the watermark never passes these. */
  pending_runs: number[];
  /** ISO timestamp of the last successful collection for this repo. */
  last_collected_at?: string;
}

export interface State {
  schema_version: number;
  repos: Record<string, RepoState>;
}

/** A fresh, empty state. */
export function emptyState(): State {
  return { schema_version: STATE_SCHEMA_VERSION, repos: {} };
}

/** Returns the repo's state, or an empty entry if this repo has never been collected. */
export function repoState(state: State, repo: string): RepoState {
  return state.repos[repo] ?? { pending_runs: [] };
}

/**
 * Loads state from `path`. A missing file yields a fresh empty state — first run is
 * not an error. Other read/parse failures propagate so corruption is never silently
 * masked.
 */
export async function loadState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as State;
  return { schema_version: parsed.schema_version, repos: parsed.repos ?? {} };
}

/**
 * Writes state as pretty JSON with a trailing newline — to a temp file first, then an atomic
 * rename. A crash mid-write must never leave a half-written state.json: {@link loadState}
 * treats corruption as fatal, so a torn write would brick every future collect. Losing the
 * *newest* state to a crash, by contrast, is safe — D12 re-collects and dedups the overlap.
 */
export async function saveState(path: string, state: State): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
