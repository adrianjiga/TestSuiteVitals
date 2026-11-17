import { describe, expect, it } from "vitest";
import { looksLikePlaywrightBlob, parsePlaywrightBlob } from "../src/adapters/playwright-blob.js";

const project = {
  name: "firefox",
  suites: [
    {
      title: "login.spec.js",
      location: { file: "login.spec.js" },
      entries: [
        {
          title: "Login",
          location: { file: "login.spec.js" },
          entries: [
            { testId: "t1", title: "works", location: { file: "login.spec.js" } },
            { testId: "t2", title: "is flaky", location: { file: "login.spec.js" } },
          ],
        },
      ],
    },
  ],
};

const lines = [
  { method: "onConfigure", params: {} },
  { method: "onProject", params: { project } },
  {
    method: "onTestEnd",
    params: {
      test: { testId: "t1" },
      result: { status: "passed", duration: 100, retry: 0, errors: [] },
    },
  },
  {
    method: "onTestEnd",
    params: {
      test: { testId: "t2" },
      result: {
        status: "failed",
        duration: 50,
        retry: 0,
        errors: [{ message: "[31mAssertionError[0m: boom", stack: "at /a/login.spec.js:5:3" }],
      },
    },
  },
  {
    method: "onTestEnd",
    params: {
      test: { testId: "t2" },
      result: { status: "passed", duration: 80, retry: 1, errors: [] },
    },
  },
];

const REPORT = lines.map((l) => JSON.stringify(l)).join("\n");

describe("looksLikePlaywrightBlob", () => {
  it("detects a teleReporter JSONL stream", () => {
    expect(looksLikePlaywrightBlob(REPORT)).toBe(true);
  });

  it("rejects JUnit XML and plain JSON", () => {
    expect(looksLikePlaywrightBlob("<testsuites/>")).toBe(false);
    expect(looksLikePlaywrightBlob('{"stats":{}}')).toBe(false);
  });
});

describe("parsePlaywrightBlob", () => {
  it("builds file, title path, and matrix from the suite tree", () => {
    const passing = parsePlaywrightBlob(REPORT).find((t) => t.title_path.includes("works"));
    expect(passing).toMatchObject({
      file: "login.spec.js",
      title_path: ["Login", "works"],
      matrix: { project: "firefox" },
      status: "passed",
    });
  });

  it("groups retries into attempts and marks the test flaky", () => {
    const flaky = parsePlaywrightBlob(REPORT).find((t) => t.title_path.includes("is flaky"));
    expect(flaky?.status).toBe("passed");
    expect(flaky?.flaky).toBe(true);
    expect(flaky?.attempts.map((a) => [a.n, a.status])).toEqual([
      [1, "failed"],
      [2, "passed"],
    ]);
    expect(flaky?.duration_ms).toBe(80); // last attempt
  });

  it("strips ANSI from the failed attempt's error message", () => {
    const flaky = parsePlaywrightBlob(REPORT).find((t) => t.title_path.includes("is flaky"));
    expect(flaky?.attempts[0]?.error?.message).toBe("AssertionError: boom");
    expect(flaky?.attempts[0]?.error?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("ignores results with no matching tree entry", () => {
    const orphan = `${JSON.stringify({ method: "onConfigure", params: {} })}\n${JSON.stringify({
      method: "onTestEnd",
      params: { test: { testId: "ghost" }, result: { status: "passed", duration: 1, retry: 0 } },
    })}`;
    expect(parsePlaywrightBlob(orphan)).toHaveLength(0);
  });

  it("judges results against the test's expectedStatus, as Playwright does", () => {
    const report = [
      { method: "onProject", params: { project } },
      {
        method: "onTestEnd",
        params: {
          test: { testId: "t1", expectedStatus: "failed" },
          result: { status: "failed", duration: 10, retry: 0, errors: [{ message: "known bug" }] },
        },
      },
      {
        method: "onTestEnd",
        params: {
          test: { testId: "t2", expectedStatus: "failed" },
          result: { status: "passed", duration: 10, retry: 0, errors: [] },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");

    const tests = parsePlaywrightBlob(report);
    const expectedFail = tests.find((t) => t.title_path.includes("works"));
    const unexpectedPass = tests.find((t) => t.title_path.includes("is flaky"));
    expect(expectedFail?.status).toBe("passed");
    expect(expectedFail?.attempts[0]?.error).toBeUndefined();
    expect(unexpectedPass?.status).toBe("failed");
  });

  it("treats a test expected to be skipped as skipped", () => {
    const report = [
      { method: "onProject", params: { project } },
      {
        method: "onTestEnd",
        params: {
          test: { testId: "t1", expectedStatus: "skipped" },
          result: { status: "skipped", duration: 0, retry: 0, errors: [] },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");

    expect(parsePlaywrightBlob(report)[0]?.status).toBe("skipped");
  });
});
