import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestEvent } from "../src/events/event.js";
import { appendEvents } from "../src/store/ndjson.js";
import { partitionPath } from "../src/store/partition.js";

function event(overrides: { id?: string; runId?: number; startedAt?: string } = {}): TestEvent {
  const { id = "id1", runId = 100, startedAt = "2026-06-24T00:00:00Z" } = overrides;
  return {
    schema_version: 1,
    id,
    file: "a.spec.ts",
    title_path: ["t"],
    framework: "junit",
    source: "artifact",
    status: "passed",
    flaky: false,
    duration_ms: 1,
    attempts: [],
    run: {
      provider: "github",
      repo: "owner/name",
      run_id: runId,
      run_attempt: 1,
      workflow: "ci.yml",
      branch: "main",
      sha: "x",
      trigger: "push",
      started_at: startedAt,
    },
    matrix: {},
    collected_at: "2026-06-24T00:00:00Z",
  };
}

describe("appendEvents", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-ndjson-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes events as NDJSON to the month partition", async () => {
    const result = await appendEvents(dir, "owner/name", [event({ id: "a" }), event({ id: "b" })]);
    expect(result).toMatchObject({ written: 2, deduped: 0, partitions: 1 });

    const path = partitionPath(dir, "owner/name", "2026-06");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).id).toBe("a");
  });

  it("dedups within a single batch", async () => {
    const result = await appendEvents(dir, "owner/name", [event({ id: "a" }), event({ id: "a" })]);
    expect(result).toMatchObject({ written: 1, deduped: 1 });
  });

  it("is idempotent: re-appending the same events writes zero (D12)", async () => {
    const events = [event({ id: "a" }), event({ id: "b" })];
    await appendEvents(dir, "owner/name", events);
    const second = await appendEvents(dir, "owner/name", events);

    expect(second).toMatchObject({ written: 0, deduped: 2 });
    const path = partitionPath(dir, "owner/name", "2026-06");
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("splits events into separate monthly partitions", async () => {
    const result = await appendEvents(dir, "owner/name", [
      event({ id: "a", startedAt: "2026-05-31T23:00:00Z" }),
      event({ id: "b", startedAt: "2026-06-01T01:00:00Z" }),
    ]);
    expect(result.partitions).toBe(2);
    expect((await readFile(partitionPath(dir, "owner/name", "2026-05"), "utf8")).trim()).toContain(
      '"id":"a"',
    );
    expect((await readFile(partitionPath(dir, "owner/name", "2026-06"), "utf8")).trim()).toContain(
      '"id":"b"',
    );
  });
});
