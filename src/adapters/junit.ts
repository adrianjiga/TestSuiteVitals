import { XMLParser } from "fast-xml-parser";
import { makeTestError, type RedactOptions } from "../events/error.js";
import type { ParsedTest, TestAttempt, TestStatus } from "../events/event.js";

export const JUNIT_FRAMEWORK = "junit";

/**
 * Cheap head-anchored sniff: after an optional BOM, XML prolog, comments, and DOCTYPE, the
 * document's root element must be `<testsuites>` or `<testsuite>`. Anchoring matters: dispatch
 * tries JUnit first, so a JSON report that merely *mentions* the tag mid-document (e.g. an error
 * message quoting XML) must not be routed here — parsing it as XML yields zero tests and silently
 * loses the real report.
 */
const JUNIT_ROOT =
  /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^[>]*(?:\[[^\]]*\])?[^>]*>\s*)?<testsuites?[\s/>]/;

export function looksLikeJUnit(content: string): boolean {
  return JUNIT_ROOT.test(content.slice(0, 4096));
}

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
  isArray: (name: string) =>
    [
      "testsuite",
      "testcase",
      "failure",
      "error",
      "flakyFailure",
      "flakyError",
      "rerunFailure",
      "rerunError",
    ].includes(name),
};

/** Surefire's records of failed runs before a retry passed. */
const FLAKY_TAGS = ["flakyFailure", "flakyError"] as const;
/** Surefire's records of retries after the first failure, when every retry also failed. */
const RERUN_TAGS = ["rerunFailure", "rerunError"] as const;

const parser = new XMLParser(XML_OPTIONS);

/**
 * For DOCTYPE-bearing documents only: fast-xml-parser expands `<!ENTITY>` definitions by default,
 * and although it blocks *recursive* entities, one long value referenced many times still expands
 * quadratically — a ~50 MB report inflating to gigabytes in memory (F1). No real JUnit emitter
 * writes a DOCTYPE, so those documents are parsed with entity processing off (references stay as
 * literal `&name;` text) rather than being dropped.
 */
const noEntitiesParser = new XMLParser({ ...XML_OPTIONS, processEntities: false });

const HAS_DOCTYPE = /<!DOCTYPE/i;

interface XmlNode {
  [key: string]: unknown;
}

/**
 * Parses a JUnit XML report into framework-agnostic tests. A test yields one attempt, unless
 * Surefire's `rerunFailingTestsCount` retried it: then each recorded retry becomes an attempt.
 */
export function parseJUnit(xml: string, options: RedactOptions = {}): ParsedTest[] {
  const activeParser = HAS_DOCTYPE.test(xml) ? noEntitiesParser : parser;
  const root = activeParser.parse(xml) as XmlNode;
  const suites = collectSuites(root);
  const tests: ParsedTest[] = [];

  for (const { suite, file } of suites) {
    const suiteName = str(suite["@_name"]);
    for (const testcase of asArray(suite.testcase)) {
      tests.push(parseTestcase(testcase, file, suiteName, options));
    }
  }

  return tests;
}

/**
 * Gathers every `<testsuite>` at any depth, under a `<testsuites>` root or a lone `<testsuite>`.
 * An inner suite without its own `file` inherits the enclosing suite's.
 */
function collectSuites(
  node: XmlNode,
  inheritedFile?: string,
): Array<{ suite: XmlNode; file: string | undefined }> {
  const found: Array<{ suite: XmlNode; file: string | undefined }> = [];
  for (const container of asArray(node.testsuites)) {
    found.push(...collectSuites(container, inheritedFile));
  }
  for (const suite of asArray(node.testsuite)) {
    const file = str(suite["@_file"]) ?? inheritedFile;
    found.push({ suite, file }, ...collectSuites(suite, file));
  }
  return found;
}

function parseTestcase(
  tc: XmlNode,
  suiteFile: string | undefined,
  suiteName: string | undefined,
  options: RedactOptions,
): ParsedTest {
  const name = str(tc["@_name"]) ?? "(unnamed test)";
  const classname = str(tc["@_classname"]);
  /**
   * Resolution order matters for test identity (D5: `id = hash(file + title_path)`).
   *
   * `classname` is preferred over `<testsuite name>` because the suite name is a *run
   * configuration label*, not a location — and the same test emits a different one depending
   * on how the run was invoked. TestNG/Surefire is the clearest case: one test yields
   * `name="TestSuite"` under `testng.xml`, `name="UI Tests"` under `testng-ui.xml`, and a
   * class-named suite element when Surefire emits per-class files. Ranking that ahead of
   * `classname` minted three identities for one test and split its history three ways.
   * pytest has the same shape at lower stakes (`<testsuite name="pytest">` for the whole run).
   *
   * Genuine path attributes still win: `<testcase file>` then `<testsuite file>` are real
   * locations when an emitter provides them. The suite name survives last, so a report with
   * neither a path nor a classname is unaffected.
   */
  const file = str(tc["@_file"]) ?? suiteFile ?? classname ?? suiteName ?? "unknown";
  const titlePath = classname && classname !== file ? [classname, name] : [name];
  const durationMs = Math.round((Number(tc["@_time"]) || 0) * 1000);

  const status = testcaseStatus(tc);
  const attempts = retryAttempts(tc, status, options);
  const final: TestAttempt = { n: attempts.length + 1, status, duration_ms: durationMs };
  if (status === "failed") {
    const error = errorFrom(asArray(tc.failure)[0] ?? asArray(tc.error)[0], options);
    if (error) {
      final.error = error;
    }
  }

  return {
    file,
    title_path: titlePath,
    status,
    flaky: status === "passed" && attempts.length > 0,
    duration_ms: durationMs,
    attempts: status === "failed" ? failedThenReruns(final, tc, options) : [...attempts, final],
  };
}

/** Failed runs that preceded a passing retry (`<flakyFailure>`/`<flakyError>`). */
function retryAttempts(tc: XmlNode, status: TestStatus, options: RedactOptions): TestAttempt[] {
  if (status !== "passed") {
    return [];
  }
  return FLAKY_TAGS.flatMap((tag) => asArray(tc[tag])).map((node, i) =>
    failedAttempt(i + 1, node, options),
  );
}

/**
 * A test that failed every retry: the `<failure>`/`<error>` is the first run, and each
 * `<rerunFailure>`/`<rerunError>` is a retry after it.
 */
function failedThenReruns(first: TestAttempt, tc: XmlNode, options: RedactOptions): TestAttempt[] {
  const reruns = RERUN_TAGS.flatMap((tag) => asArray(tc[tag]));
  return [{ ...first, n: 1 }, ...reruns.map((node, i) => failedAttempt(i + 2, node, options))];
}

function failedAttempt(n: number, node: XmlNode, options: RedactOptions): TestAttempt {
  const attempt: TestAttempt = { n, status: "failed", duration_ms: 0 };
  const error = errorFrom(node, options);
  if (error) {
    attempt.error = error;
  }
  return attempt;
}

function testcaseStatus(tc: XmlNode): TestStatus {
  if ("skipped" in tc) {
    return "skipped";
  }
  const failures = [tc.failure, tc.error, ...RERUN_TAGS.map((tag) => tc[tag])];
  if (failures.some((value) => asArray(value).length > 0)) {
    return "failed";
  }
  return "passed";
}

function errorFrom(node: XmlNode | undefined, options: RedactOptions) {
  if (node === undefined) {
    return undefined;
  }
  if (typeof node === "string") {
    return makeTestError({ message: node }, options);
  }
  const detail = node as XmlNode;
  const message = str(detail["@_message"]) ?? str(detail["#text"]) ?? "Test failed";
  const stack = str(detail["#text"]) ?? "";
  return makeTestError({ message, stack }, options);
}

function asArray(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    return value as XmlNode[];
  }
  return value === undefined ? [] : [value as XmlNode];
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}
