import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyState,
  loadState,
  repoState,
  STATE_SCHEMA_VERSION,
  saveState,
} from "../src/state/state.js";

describe("state", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-state-"));
    path = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a fresh empty state when the file is missing (first run)", async () => {
    const state = await loadState(path);
    expect(state).toEqual(emptyState());
    expect(state.schema_version).toBe(STATE_SCHEMA_VERSION);
  });

  it("round-trips state through save and load", async () => {
    const state = emptyState();
    state.repos["adrianjiga/TestSuiteVitals"] = {
      watermark: "2026-06-20T00:00:00Z",
      pending_runs: [42],
      last_collected_at: "2026-06-23T00:00:00Z",
    };

    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
  });

  it("saves atomically — no temp file survives, and an existing file is replaced whole", async () => {
    await saveState(path, emptyState());
    const next = emptyState();
    next.repos["o/r"] = { pending_runs: [] };
    await saveState(path, next);

    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(await loadState(path)).toEqual(next);
  });

  it("repoState yields an empty entry for an unknown repo", () => {
    expect(repoState(emptyState(), "owner/name")).toEqual({ pending_runs: [] });
  });

  it("propagates parse errors instead of masking corruption", async () => {
    await writeFile(path, "{ not valid json", "utf8");
    await expect(loadState(path)).rejects.toThrow();
  });
});
