import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { type DetectedReport, detectAndParse } from "../adapters/dispatch.js";
import type { RunReports } from "../artifacts/fetch.js";
import { buildEvent, type RunContext, type TestEvent } from "../events/event.js";
import type { WorkflowRun } from "../github/runs.js";

/** Extensions worth reading as report candidates: JUnit XML, Playwright JSONL, mochawesome JSON. */
const CANDIDATE_EXTENSIONS = new Set([".xml", ".jsonl", ".json"]);

export interface ParseSummary {
  filesScanned: number;
  filesParsed: number;
  /** Candidate files that threw during read or parse — warned and skipped, never fatal (F1). */
  filesFailed: number;
  eventsBuilt: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ParseResult {
  events: TestEvent[];
  summary: ParseSummary;
}

export interface ParseOptions {
  fullErrors?: boolean;
  /** Timestamp stamped as `collected_at`; injectable for tests. */
  now?: Date;
}

function emptySummary(): ParseSummary {
  return {
    filesScanned: 0,
    filesParsed: 0,
    filesFailed: 0,
    eventsBuilt: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
}

/**
 * Reads each run's extracted report files, dispatches them to the matching adapter,
 * and enriches the parsed tests into events. Non-report files (HTML, assets) are
 * skipped by extension, then by the adapter sniff.
 */
export async function parseRunReports(
  reports: RunReports[],
  repoSlug: string,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const collectedAt = (options.now ?? new Date()).toISOString();
  const events: TestEvent[] = [];
  const summary = emptySummary();

  for (const report of reports) {
    const run = runContext(repoSlug, report.run);
    for (const file of report.files) {
      if (!CANDIDATE_EXTENSIONS.has(extname(file).toLowerCase())) {
        continue;
      }
      summary.filesScanned++;

      let detected: DetectedReport | null;
      try {
        const content = await readFile(file, "utf8");
        detected = detectAndParse(content, { fullErrors: options.fullErrors });
      } catch (error) {
        // A truncated upload or a hostile document (invalid JSON past the sniff, pathological
        // XML, absurd nesting) is deterministic content — retrying yields the same bytes — so
        // it costs this one file, with a warning, never the whole collect (F1).
        summary.filesFailed++;
        console.warn(`Skipping unparseable report file ${file}: ${(error as Error).message}`);
        continue;
      }
      if (!detected) {
        continue;
      }
      summary.filesParsed++;

      for (const test of detected.tests) {
        events.push(
          buildEvent(test, {
            framework: detected.framework,
            run,
            matrix: {},
            collected_at: collectedAt,
          }),
        );
        summary.eventsBuilt++;
        countStatus(summary, test.status);
      }
    }
  }

  return { events, summary };
}

function countStatus(summary: ParseSummary, status: TestEvent["status"]): void {
  if (status === "passed") {
    summary.passed++;
  } else if (status === "failed") {
    summary.failed++;
  } else {
    summary.skipped++;
  }
}

function runContext(repo: string, run: WorkflowRun): RunContext {
  return {
    provider: "github",
    repo,
    run_id: run.run_id,
    run_attempt: run.run_attempt,
    workflow: run.workflow,
    branch: run.branch,
    sha: run.sha,
    trigger: run.trigger,
    started_at: run.created_at,
  };
}
