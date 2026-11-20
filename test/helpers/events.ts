import type { RunContext, TestEvent } from "../../src/events/event.js";

/** Builds a TestEvent with sensible defaults; `run` is merged shallowly over the default run. */
export function ev(
  over: Partial<Omit<TestEvent, "run">> & { run?: Partial<RunContext> } = {},
): TestEvent {
  const { run, ...rest } = over;
  return {
    schema_version: 1,
    id: "t1",
    file: "a.spec.ts",
    title_path: ["A", "does x"],
    framework: "junit",
    source: "artifact",
    status: "passed",
    flaky: false,
    duration_ms: 10,
    attempts: [{ n: 1, status: "passed", duration_ms: 10 }],
    matrix: {},
    collected_at: "2026-06-01T00:00:00Z",
    ...rest,
    run: {
      provider: "github",
      repo: "o/r",
      run_id: 1,
      run_attempt: 1,
      workflow: "ci.yml",
      branch: "main",
      sha: "sha1",
      trigger: "push",
      started_at: "2026-06-01T00:00:00Z",
      ...run,
    },
  };
}

/** A single-attempt failure with the given error fingerprint. */
export function failed(
  over: Partial<Omit<TestEvent, "run">> & { run?: Partial<RunContext> } = {},
  fingerprint = "fp1",
): TestEvent {
  return ev({
    status: "failed",
    attempts: [{ n: 1, status: "failed", duration_ms: 5, error: { message: "boom", fingerprint } }],
    ...over,
  });
}

/** ISO start time `i` hours after a fixed origin, so run order is explicit. */
export function hour(i: number): string {
  return new Date(Date.UTC(2026, 5, 1) + i * 3_600_000).toISOString();
}

/** Deterministic PRNG (mulberry32) so "random" failure fixtures are reproducible. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
