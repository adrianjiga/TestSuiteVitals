import { describe, expect, it } from "vitest";
import { looksLikeMochawesome, parseMochawesome } from "../src/adapters/mochawesome.js";

/** Minimal mochawesome report builder: one spec file with a nested suite tree. */
function report(rootSuite: Record<string, unknown>) {
  return JSON.stringify({
    stats: { tests: 0, passes: 0, failures: 0, pending: 0, passPercent: 100, testsRegistered: 0 },
    results: [
      { uuid: "r", title: "", fullFile: "cypress/e2e/app.cy.js", root: true, ...rootSuite },
    ],
    meta: {},
  });
}

function test(over: Record<string, unknown> = {}) {
  return { title: "does a thing", state: "passed", pass: true, duration: 12, err: {}, ...over };
}

describe("looksLikeMochawesome", () => {
  it("recognizes a mochawesome report by its stats keys", () => {
    expect(looksLikeMochawesome(report({ tests: [test()] }))).toBe(true);
  });

  it("rejects unrelated JSON and JUnit XML", () => {
    expect(looksLikeMochawesome('{"config":{},"suites":[]}')).toBe(false);
    expect(looksLikeMochawesome("<testsuites/>")).toBe(false);
  });
});

describe("parseMochawesome", () => {
  it("walks nested suites, skipping the root title, into the title path", () => {
    const content = report({
      tests: [],
      suites: [
        {
          title: "Outer",
          tests: [test({ title: "top-level case" })],
          suites: [{ title: "Inner", tests: [test({ title: "nested case" })] }],
        },
      ],
    });

    const tests = parseMochawesome(content);

    expect(tests.map((t) => t.title_path)).toEqual([
      ["Outer", "top-level case"],
      ["Outer", "Inner", "nested case"],
    ]);
    expect(tests.every((t) => t.file === "cypress/e2e/app.cy.js")).toBe(true);
  });

  it("maps the three status fields, treating pending/skipped as skipped", () => {
    const content = report({
      tests: [
        test({ title: "ok", state: "passed", pass: true }),
        test({
          title: "broke",
          state: "failed",
          pass: false,
          fail: true,
          err: { message: "boom" },
        }),
        test({ title: "todo", state: undefined, pass: false, pending: true }),
        test({ title: "bailed", skipped: true, pass: false }),
      ],
    });

    const byTitle = Object.fromEntries(
      parseMochawesome(content).map((t) => [t.title_path.at(-1), t]),
    );
    expect(byTitle.ok?.status).toBe("passed");
    expect(byTitle.broke?.status).toBe("failed");
    expect(byTitle.todo?.status).toBe("skipped");
    expect(byTitle.bailed?.status).toBe("skipped");
  });

  it("attaches a redacted, fingerprinted error to a failed test", () => {
    const content = report({
      tests: [
        test({
          title: "broke",
          state: "failed",
          pass: false,
          fail: true,
          err: {
            message: "token=ghp_aaaaaaaaaaaaaaaaaaaaaaaa leaked",
            estack: "at foo (/a/b.js:1:2)",
          },
        }),
      ],
    });

    const [failed] = parseMochawesome(content);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts[0]?.error?.message).toContain("[REDACTED]");
    expect(failed?.attempts[0]?.error?.message).not.toContain("ghp_");
    expect(failed?.attempts[0]?.error?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("emits one non-flaky attempt per test (mochawesome is flat)", () => {
    const [t] = parseMochawesome(report({ tests: [test()] }));
    expect(t?.flaky).toBe(false);
    expect(t?.attempts).toHaveLength(1);
    expect(t?.attempts[0]).toMatchObject({ n: 1, status: "passed", duration_ms: 12 });
  });

  it("prefers the relative file over Mocha's absolute fullFile", () => {
    const json = JSON.stringify({
      stats: { tests: 1, passes: 1, failures: 0, pending: 0, passPercent: 100, testsRegistered: 1 },
      results: [
        {
          uuid: "r",
          title: "",
          root: true,
          fullFile: "/home/runner/work/app/app/test/login.spec.js",
          file: "test/login.spec.js",
          tests: [test()],
          suites: [],
        },
      ],
      meta: {},
    });
    expect(parseMochawesome(json)[0]?.file).toBe("test/login.spec.js");
  });
});
