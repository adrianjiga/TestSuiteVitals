import { makeTestError, type RedactOptions } from "../events/error.js";
import type { ParsedTest, TestAttempt, TestStatus } from "../events/event.js";

export const MOCHAWESOME_FRAMEWORK = "mochawesome";

/**
 * Cheap content sniff: a mochawesome report is a single JSON object whose `stats`
 * carry the distinctive `passPercent` + `testsRegistered` keys. Both appear at the
 * very start of the document, so a head slice is enough.
 */
export function looksLikeMochawesome(content: string): boolean {
  const head = content.slice(0, 2000);
  return /"passPercent"\s*:/.test(head) && /"testsRegistered"\s*:/.test(head);
}

// Minimal shapes of the mochawesome nodes we read.
interface MochaErr {
  message?: string;
  estack?: string;
  stack?: string;
}
interface MochaTest {
  title?: string;
  state?: string;
  pass?: boolean;
  fail?: boolean;
  pending?: boolean;
  skipped?: boolean;
  duration?: number;
  err?: MochaErr;
}
interface MochaSuite {
  title?: string;
  root?: boolean;
  file?: string;
  fullFile?: string;
  tests?: MochaTest[];
  suites?: MochaSuite[];
}
interface MochaReport {
  results?: MochaSuite[];
}

/**
 * Parses a mochawesome JSON report (Cypress/Mocha) into framework-agnostic tests.
 * Each `results[]` entry is a per-spec root suite holding a tree of `suites`/`tests`;
 * the walk accumulates describe titles into the title path, skipping the root node's
 * title (the spec filename, not a describe). Mochawesome is flat per test — one attempt,
 * never flaky; the richer `attempts[]` comes from Playwright and Surefire retries.
 */
export function parseMochawesome(content: string, options: RedactOptions = {}): ParsedTest[] {
  const report = JSON.parse(content) as MochaReport;
  const tests: ParsedTest[] = [];

  for (const result of report.results ?? []) {
    const file = result.file || result.fullFile || "unknown";
    walkSuite(result, file, [], tests, options);
  }

  return tests;
}

/** Recursively walks a suite tree, accumulating describe titles into the title path. */
function walkSuite(
  suite: MochaSuite,
  file: string,
  titlePath: string[],
  tests: ParsedTest[],
  options: RedactOptions,
): void {
  for (const test of suite.tests ?? []) {
    tests.push(toTest(test, file, titlePath, options));
  }
  for (const child of suite.suites ?? []) {
    // The root node's title is the spec filename, not a real describe — skip it.
    const childPath = child.root || !child.title ? titlePath : [...titlePath, child.title];
    walkSuite(child, file, childPath, tests, options);
  }
}

function toTest(
  test: MochaTest,
  file: string,
  titlePath: string[],
  options: RedactOptions,
): ParsedTest {
  const status = mapStatus(test);
  const durationMs = test.duration ?? 0;
  const attempt: TestAttempt = { n: 1, status, duration_ms: durationMs };
  if (status === "failed") {
    const error = toError(test.err, options);
    if (error) {
      attempt.error = error;
    }
  }

  return {
    file,
    title_path: [...titlePath, test.title ?? "(unnamed test)"],
    status,
    flaky: false,
    duration_ms: durationMs,
    attempts: [attempt],
  };
}

/** Maps mochawesome's redundant status fields; a pending/skipped test is never a real status. */
function mapStatus(test: MochaTest): TestStatus {
  if (test.pending || test.skipped) {
    return "skipped";
  }
  if (test.state === "failed" || test.fail) {
    return "failed";
  }
  if (test.state === "passed" || test.pass) {
    return "passed";
  }
  return "skipped";
}

function toError(err: MochaErr | undefined, options: RedactOptions) {
  if (!err) {
    return undefined;
  }
  const message = err.message ?? "Test failed";
  const stack = err.estack ?? err.stack ?? "";
  return makeTestError({ message, stack }, options);
}
