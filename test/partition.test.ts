import { describe, expect, it } from "vitest";
import type { TestEvent } from "../src/events/event.js";
import { partitionMonth, partitionPath, repoDir } from "../src/store/partition.js";

function event(startedAt: string): TestEvent {
  return {
    schema_version: 1,
    id: "abc",
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
      run_id: 1,
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

describe("partitioning", () => {
  it("partitions by the run's month, not the collection month", () => {
    // Started in May though collected in June.
    expect(partitionMonth(event("2026-05-30T23:00:00Z"))).toBe("2026-05");
  });

  it("maps owner/name to owner__name", () => {
    expect(repoDir("adrianjiga/TestSuiteVitals")).toBe("adrianjiga__TestSuiteVitals");
  });

  it("builds the partition path", () => {
    expect(partitionPath("data", "owner/name", "2026-06")).toBe("data/owner__name/2026-06.ndjson");
  });
});
