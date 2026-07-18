import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunReports } from "../src/artifacts/fetch.js";
import { parseRunReports } from "../src/collect/parse.js";
import type { WorkflowRun } from "../src/github/runs.js";

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

  it("parses JUnit files and enriches events with run context", async () => {
    const xml = join(dir, "junit.xml");
    const html = join(dir, "report.html");
    await writeFile(xml, JUNIT);
    await writeFile(html, "<html>not a report</html>");
    const reports: RunReports[] = [{ run, files: [xml, html] }];

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
        [{ run, files: [broken, good] }],
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
