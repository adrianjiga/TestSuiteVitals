import { describe, expect, it } from "vitest";
import type { TestEvent } from "../src/events/event.js";
import { dedupKey } from "../src/store/dedup.js";

function event(
  overrides: Partial<TestEvent> & { matrix?: Record<string, string> } = {},
): TestEvent {
  return {
    schema_version: 1,
    id: "id1",
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
      run_id: 100,
      run_attempt: 1,
      workflow: "ci.yml",
      branch: "main",
      sha: "x",
      trigger: "push",
      started_at: "2026-06-24T00:00:00Z",
    },
    matrix: {},
    collected_at: "2026-06-24T00:00:00Z",
    ...overrides,
  };
}

describe("dedupKey", () => {
  it("is identical for the same (run_id, run_attempt, id, matrix)", () => {
    expect(dedupKey(event())).toBe(dedupKey(event()));
  });

  it("is independent of matrix key order", () => {
    const a = event({ matrix: { browser: "firefox", viewport: "desktop" } });
    const b = event({ matrix: { viewport: "desktop", browser: "firefox" } });
    expect(dedupKey(a)).toBe(dedupKey(b));
  });

  it.each([
    ["run_id", event({ run: { ...event().run, run_id: 999 } })],
    ["run_attempt", event({ run: { ...event().run, run_attempt: 2 } })],
    ["id", event({ id: "id2" })],
    ["matrix", event({ matrix: { browser: "chrome" } })],
  ])("changes when %s changes", (_label, variant) => {
    expect(dedupKey(variant)).not.toBe(dedupKey(event()));
  });
});
