import { makeTestError, type RedactOptions } from "../events/error.js";
import {
  deriveFlaky,
  deriveStatus,
  type ParsedTest,
  type TestAttempt,
  type TestStatus,
} from "../events/event.js";

export const PLAYWRIGHT_FRAMEWORK = "playwright";

/** Strips ANSI color codes that Playwright embeds in error messages. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition.
const ANSI = /\[[0-9;]*m/g;

/**
 * Sniffs a Playwright blob report (`report.jsonl`): a JSON-lines stream of teleReporter
 * events whose first lines carry `"method":"on…"`.
 */
export function looksLikePlaywrightBlob(content: string): boolean {
  return /"method"\s*:\s*"on(Configure|BlobReportMetadata|Project|Begin)"/.test(
    content.slice(0, 1000),
  );
}

interface TreeTest {
  file: string;
  titlePath: string[];
  matrix: Record<string, string>;
}

interface RawAttempt {
  retry: number;
  status: TestStatus;
  duration_ms: number;
  errors: PwError[];
}

interface PwError {
  message?: string;
  stack?: string;
  value?: string;
}

// Minimal shapes of the teleReporter nodes we read.
interface PwNode {
  testId?: string;
  title?: string;
  location?: { file?: string };
  entries?: PwNode[];
}
interface PwEvent {
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Parses a Playwright blob report into tests. The teleReporter `onProject` events carry
 * the suite tree (file → describe → test via `entries`) and the project name (the matrix
 * cell); `onTestEnd` events carry per-retry results, which become `attempts[]`.
 */
export function parsePlaywrightBlob(content: string, options: RedactOptions = {}): ParsedTest[] {
  const events = parseJsonl(content);

  const tree = new Map<string, TreeTest>();
  const results = new Map<string, RawAttempt[]>();

  for (const event of events) {
    if (event.method === "onProject") {
      indexProject(event.params?.project as PwProject | undefined, tree);
    } else if (event.method === "onTestEnd") {
      indexResult(event.params, results);
    }
  }

  const tests: ParsedTest[] = [];
  for (const [testId, rawAttempts] of results) {
    const info = tree.get(testId);
    if (!info) {
      continue;
    }
    rawAttempts.sort((a, b) => a.retry - b.retry);
    const attempts = rawAttempts.map((raw) => toAttempt(raw, options));

    tests.push({
      file: info.file,
      title_path: info.titlePath,
      status: deriveStatus(attempts),
      flaky: deriveFlaky(attempts),
      duration_ms: attempts.at(-1)?.duration_ms ?? 0,
      attempts,
      matrix: info.matrix,
    });
  }

  return tests;
}

interface PwProject {
  name?: string;
  suites?: PwNode[];
}

function indexProject(project: PwProject | undefined, tree: Map<string, TreeTest>): void {
  if (!project) {
    return;
  }
  const matrix: Record<string, string> = project.name ? { project: project.name } : {};
  for (const fileSuite of project.suites ?? []) {
    const file = fileSuite.location?.file ?? fileSuite.title ?? "unknown";
    for (const entry of fileSuite.entries ?? []) {
      walk(entry, [], file, matrix, tree);
    }
  }
}

/** Recursively walks the suite tree, accumulating describe titles into the title path. */
function walk(
  node: PwNode,
  titlePath: string[],
  file: string,
  matrix: Record<string, string>,
  tree: Map<string, TreeTest>,
): void {
  const nodeFile = node.location?.file ?? file;
  if (node.testId) {
    tree.set(node.testId, { file: nodeFile, titlePath: [...titlePath, node.title ?? ""], matrix });
    return;
  }
  const childPath = node.title ? [...titlePath, node.title] : titlePath;
  for (const entry of node.entries ?? []) {
    walk(entry, childPath, nodeFile, matrix, tree);
  }
}

function indexResult(
  params: Record<string, unknown> | undefined,
  results: Map<string, RawAttempt[]>,
): void {
  const test = params?.test as { testId?: string; expectedStatus?: string } | undefined;
  const result = params?.result as
    | { status?: string; duration?: number; retry?: number; errors?: PwError[] }
    | undefined;
  if (!test?.testId || !result) {
    return;
  }
  const attempt: RawAttempt = {
    retry: result.retry ?? 0,
    status: mapStatus(result.status, test.expectedStatus),
    duration_ms: result.duration ?? 0,
    errors: result.errors ?? [],
  };
  const bucket = results.get(test.testId);
  if (bucket) {
    bucket.push(attempt);
  } else {
    results.set(test.testId, [attempt]);
  }
}

function toAttempt(raw: RawAttempt, options: RedactOptions): TestAttempt {
  const attempt: TestAttempt = {
    n: raw.retry + 1,
    status: raw.status,
    duration_ms: raw.duration_ms,
  };
  if (raw.status === "failed") {
    const error = toError(raw.errors, options);
    if (error) {
      attempt.error = error;
    }
  }
  return attempt;
}

function toError(errors: PwError[], options: RedactOptions) {
  const first = errors[0];
  if (!first) {
    return undefined;
  }
  const message = stripAnsi(first.message ?? first.value ?? "Test failed");
  const stack = stripAnsi(first.stack ?? "");
  return makeTestError({ message, stack }, options);
}

/**
 * Playwright judges a result against the test's `expectedStatus`, not in absolute terms: a
 * `test.fail()` test that fails is passing, and one that unexpectedly passes is a failure.
 */
function mapStatus(status: string | undefined, expectedStatus = "passed"): TestStatus {
  if (status === "skipped" || expectedStatus === "skipped") {
    return "skipped";
  }
  return status === expectedStatus ? "passed" : "failed";
}

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function parseJsonl(content: string): PwEvent[] {
  const events: PwEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as PwEvent);
    } catch {
      // Skip malformed lines rather than fail the whole report.
    }
  }
  return events;
}
