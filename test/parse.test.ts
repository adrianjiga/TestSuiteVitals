import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedFile, RunReports } from "../src/artifacts/fetch.js";
import { compileMatrixPattern } from "../src/collect/matrix.js";
import { parseRunReports } from "../src/collect/parse.js";
import type { WorkflowRun } from "../src/github/runs.js";

/** An extracted file tagged with the artifact it came from. */
const file = (path: string, artifact: string, attempt = 1): ExtractedFile => ({
  path,
  artifact,
  attempt,
});

const run: WorkflowRun = {
  run_id: 7,
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
  workflow: "ci.yml",
  branch: "main",
  sha: "abc",
  trigger: "push",
  created_at: "2026-06-23T10:00:00Z",
};

const JUNIT = `<testsuites><testsuite name="s" file="s.spec.ts">
  <testcase classname="s.spec.ts" name="ok" time="0.1"/>
  <testcase classname="s.spec.ts" name="bad" time="0.2"><failure message="boom"/></testcase>
</testsuite></testsuites>`;

describe("parseRunReports", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "suitevitals-parse-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps one run's matrix cells distinct under the dedup key", async () => {
    // The regression this guards: with an empty matrix, every cell's result for a test shared
    // the dedup key (run_id, run_attempt, id, matrix) — so the first written won and the rest
    // were dropped. A test failing only on Firefox was undetectable.
    const chrome = join(dir, "chrome.xml");
    const firefox = join(dir, "firefox.xml");
    await writeFile(chrome, JUNIT);
    await writeFile(firefox, JUNIT);

    const { events } = await parseRunReports(
      [
        {
          run,
          files: [
            file(chrome, "cypress-results-ui-chrome-desktop"),
            file(firefox, "cypress-results-ui-firefox-desktop"),
          ],
        },
      ],
      "owner/name",
      {
        now: new Date("2026-06-23T12:00:00Z"),
        matrixPattern: compileMatrixPattern(
          "cypress-results-(?<group>[^-]+)-(?<browser>[^-]+)-(?<viewport>[^-]+)",
        ),
      },
    );

    // Same tests, same run — but two cells, so two distinct dedup keys per test.
    const keys = new Set(events.map((e) => `${e.id}|${JSON.stringify(e.matrix)}`));
    expect(keys.size).toBe(events.length);
    expect(new Set(events.map((e) => e.matrix?.browser))).toEqual(new Set(["chrome", "firefox"]));
    // Identity is unchanged by the cell (D5) — both cells report the same tests.
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("stamps each event with its file's attempt, not the run's latest attempt", async () => {
    const carried = join(dir, "carried.xml");
    const rerun = join(dir, "rerun.xml");
    await writeFile(carried, JUNIT);
    await writeFile(rerun, JUNIT);

    const { events } = await parseRunReports(
      [
        {
          run: { ...run, run_attempt: 2 },
          files: [file(carried, "api-results", 1), file(rerun, "ui-results", 2)],
        },
      ],
      "owner/name",
    );

    expect(
      events.filter((e) => e.matrix?.artifact === "api-results").map((e) => e.run.run_attempt),
    ).toEqual([1, 1]);
    expect(
      events.filter((e) => e.matrix?.artifact === "ui-results").map((e) => e.run.run_attempt),
    ).toEqual([2, 2]);
  });

  it("tags events with the opaque artifact name when no pattern is given", async () => {
    const xml = join(dir, "junit.xml");
    await writeFile(xml, JUNIT);

    const { events } = await parseRunReports(
      [{ run, files: [file(xml, "test-reports-ui")] }],
      "owner/name",
      { now: new Date("2026-06-23T12:00:00Z") },
    );

    expect(events[0]?.matrix).toEqual({ artifact: "test-reports-ui" });
  });

  it("parses JUnit files and enriches events with run context", async () => {
    const xml = join(dir, "junit.xml");
    const html = join(dir, "report.html");
    await writeFile(xml, JUNIT);
    await writeFile(html, "<html>not a report</html>");
    const reports: RunReports[] = [
      { run, files: [file(xml, "junit-results"), file(html, "junit-results")] },
    ];

    const { events, summary } = await parseRunReports(reports, "owner/name", {
      now: new Date("2026-06-23T12:00:00Z"),
    });

    // The .html file is skipped by extension; only junit.xml is scanned.
    expect(summary.filesScanned).toBe(1);
    expect(summary.filesParsed).toBe(1);
    expect(summary.eventsBuilt).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);

    expect(events).toHaveLength(2);
    expect(events[0]?.run.repo).toBe("owner/name");
    expect(events[0]?.run.run_id).toBe(7);
    expect(events[0]?.collected_at).toBe("2026-06-23T12:00:00.000Z");
    expect(events[0]?.framework).toBe("junit");
  });

  it("produces no events when there are no candidate files", async () => {
    const { events, summary } = await parseRunReports([{ run, files: [] }], "owner/name");
    expect(events).toHaveLength(0);
    expect(summary.filesScanned).toBe(0);
  });

  it("warns and continues when a candidate file cannot be parsed", async () => {
    // Passes the mochawesome sniff but is truncated mid-document — JSON.parse throws.
    const broken = join(dir, "mochawesome.json");
    await writeFile(broken, '{"stats":{"passPercent":100,"testsRegistered":2},"results":[');
    const good = join(dir, "junit.xml");
    await writeFile(good, JUNIT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { events, summary } = await parseRunReports(
        [{ run, files: [file(broken, "reports"), file(good, "reports")] }],
        "owner/name",
      );

      expect(summary.filesFailed).toBe(1); // the truncated file, surfaced not fatal
      expect(summary.filesParsed).toBe(1); // the healthy report still parsed
      expect(events).toHaveLength(2);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
