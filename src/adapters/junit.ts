import { XMLParser } from "fast-xml-parser";
import { makeTestError, type RedactOptions } from "../events/error.js";
import type { ParsedTest, TestAttempt, TestStatus } from "../events/event.js";

export const JUNIT_FRAMEWORK = "junit";

/** Cheap content sniff: a JUnit report's root is `<testsuites>` or `<testsuite>`. */
export function looksLikeJUnit(content: string): boolean {
  return /<testsuites?[\s>]/.test(content);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["testsuite", "testcase", "failure", "error"].includes(name),
});

interface XmlNode {
  [key: string]: unknown;
}

/**
 * Parses a JUnit XML report into framework-agnostic tests. JUnit is flat — each test
 * yields a single attempt; the richer `attempts[]` comes from Playwright/Mochawesome.
 */
export function parseJUnit(xml: string, options: RedactOptions = {}): ParsedTest[] {
  const root = parser.parse(xml) as XmlNode;
  const suites = collectSuites(root);
  const tests: ParsedTest[] = [];

  for (const suite of suites) {
    const suiteFile = str(suite["@_file"]) ?? str(suite["@_name"]);
    for (const testcase of asArray(suite.testcase)) {
      tests.push(parseTestcase(testcase, suiteFile, options));
    }
  }

  return tests;
}

/** Gathers `<testsuite>` nodes whether the root is `<testsuites>` or a lone `<testsuite>`. */
function collectSuites(root: XmlNode): XmlNode[] {
  const container = root.testsuites as XmlNode | undefined;
  if (container) {
    return asArray(container.testsuite);
  }
  return asArray(root.testsuite);
}

function parseTestcase(
  tc: XmlNode,
  suiteFile: string | undefined,
  options: RedactOptions,
): ParsedTest {
  const name = str(tc["@_name"]) ?? "(unnamed test)";
  const classname = str(tc["@_classname"]);
  const file = str(tc["@_file"]) ?? suiteFile ?? classname ?? "unknown";
  const titlePath = classname && classname !== file ? [classname, name] : [name];
  const durationMs = Math.round((Number(tc["@_time"]) || 0) * 1000);

  const status = testcaseStatus(tc);
  const attempt: TestAttempt = { n: 1, status, duration_ms: durationMs };
  if (status === "failed") {
    const error = testcaseError(tc, options);
    if (error) {
      attempt.error = error;
    }
  }

  return {
    file,
    title_path: titlePath,
    status,
    flaky: false,
    duration_ms: durationMs,
    attempts: [attempt],
  };
}

function testcaseStatus(tc: XmlNode): TestStatus {
  if ("skipped" in tc) {
    return "skipped";
  }
  if (asArray(tc.failure).length > 0 || asArray(tc.error).length > 0) {
    return "failed";
  }
  return "passed";
}

function testcaseError(tc: XmlNode, options: RedactOptions) {
  const node = asArray(tc.failure)[0] ?? asArray(tc.error)[0];
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
