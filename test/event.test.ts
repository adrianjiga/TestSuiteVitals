import { describe, expect, it } from "vitest";
import {
  buildEvent,
  deriveFlaky,
  deriveStatus,
  EVENT_SCHEMA_VERSION,
  normalizeTestFile,
  type ParsedTest,
  type RunContext,
  type TestAttempt,
  testId,
} from "../src/events/event.js";

describe("testId", () => {
  it("is stable for the same file and title path", () => {
    expect(testId("a.spec.ts", ["Suite", "test"])).toBe(testId("a.spec.ts", ["Suite", "test"]));
  });

  it("differs when file or title path differs", () => {
    expect(testId("a.spec.ts", ["t"])).not.toBe(testId("b.spec.ts", ["t"]));
    expect(testId("a.spec.ts", ["t1"])).not.toBe(testId("a.spec.ts", ["t2"]));
  });

  it("does not collide across segment boundaries", () => {
    expect(testId("a", ["b", "c"])).not.toBe(testId("a b", ["c"]));
  });
});

describe("derive helpers", () => {
  const attempt = (status: TestAttempt["status"]): TestAttempt => ({
    n: 1,
    status,
    duration_ms: 1,
  });

  it("status is the last attempt's outcome", () => {
    expect(deriveStatus([attempt("failed"), attempt("passed")])).toBe("passed");
  });

  it("flaky when it passed after a failure", () => {
    expect(deriveFlaky([attempt("failed"), attempt("passed")])).toBe(true);
  });

  it("not flaky when it failed outright or passed first try", () => {
    expect(deriveFlaky([attempt("failed")])).toBe(false);
    expect(deriveFlaky([attempt("passed")])).toBe(false);
  });
});

describe("buildEvent", () => {
  const run: RunContext = {
    provider: "github",
    repo: "owner/name",
    run_id: 1,
    run_attempt: 1,
    workflow: "ci.yml",
    branch: "main",
    sha: "abc",
    trigger: "push",
    started_at: "2026-06-23T10:00:00Z",
  };

  const test: ParsedTest = {
    file: "a.spec.ts",
    title_path: ["Suite", "test"],
    status: "passed",
    flaky: false,
    duration_ms: 12,
    attempts: [{ n: 1, status: "passed", duration_ms: 12 }],
  };

  it("enriches a parsed test into a full event", () => {
    const event = buildEvent(test, {
      framework: "junit",
      run,
      matrix: { browser: "firefox" },
      collected_at: "2026-06-23T12:00:00Z",
    });

    expect(event).toMatchObject({
      schema_version: EVENT_SCHEMA_VERSION,
      id: testId(test.file, test.title_path),
      framework: "junit",
      source: "artifact",
      status: "passed",
      run,
      matrix: { browser: "firefox" },
      collected_at: "2026-06-23T12:00:00Z",
    });
  });

  it("prefers a matrix carried on the parsed test over the context default", () => {
    const event = buildEvent(
      { ...test, matrix: { project: "tablet" } },
      { framework: "playwright", run, matrix: {}, collected_at: "2026-06-23T12:00:00Z" },
    );
    expect(event.matrix).toEqual({ project: "tablet" });
  });
});

describe("normalizeTestFile", () => {
  it("strips GitHub-hosted runner workspace roots so every OS yields the same path", () => {
    expect(normalizeTestFile("/home/runner/work/app/app/test/login.spec.js")).toBe(
      "test/login.spec.js",
    );
    expect(normalizeTestFile("/Users/runner/work/app/app/test/login.spec.js")).toBe(
      "test/login.spec.js",
    );
    expect(normalizeTestFile("D:\\a\\app\\app\\test\\login.spec.js")).toBe("test/login.spec.js");
  });

  it("strips self-hosted and container-job workspace roots too", () => {
    expect(normalizeTestFile("/opt/actions-runner/_work/app/app/test/login.spec.js")).toBe(
      "test/login.spec.js",
    );
    expect(normalizeTestFile("C:\\actions-runner\\_work\\app\\app\\test\\login.spec.js")).toBe(
      "test/login.spec.js",
    );
    expect(normalizeTestFile("/__w/app/app/test/login.spec.js")).toBe("test/login.spec.js");
  });

  it("leaves relative paths and class names unchanged, so existing ids are stable", () => {
    expect(normalizeTestFile("cypress/e2e/buttons.cy.ts")).toBe("cypress/e2e/buttons.cy.ts");
    expect(normalizeTestFile("com.example.LoginTest")).toBe("com.example.LoginTest");
  });

  it("gives a test the same id whichever runner reported it", () => {
    const run = {
      provider: "github",
      repo: "o/r",
      run_id: 1,
      run_attempt: 1,
      workflow: "ci",
      branch: "main",
      sha: "abc",
      trigger: "push",
      started_at: "2026-06-23T10:00:00Z",
    } as const;
    const parsed = (file: string): ParsedTest => ({
      file,
      title_path: ["logs in"],
      status: "passed",
      flaky: false,
      duration_ms: 1,
      attempts: [],
    });
    const context = { framework: "mocha", run, matrix: {}, collected_at: "2026-06-23T11:00:00Z" };
    const linux = buildEvent(parsed("/home/runner/work/app/app/test/a.js"), context);
    const windows = buildEvent(parsed("D:\\a\\app\\app\\test\\a.js"), context);
    expect(windows.id).toBe(linux.id);
    expect(linux.id).toBe(testId("test/a.js", ["logs in"]));
  });
});
