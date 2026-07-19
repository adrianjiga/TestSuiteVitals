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
  isArray: (name: string) => ["testsuite", "testcase", "failure", "error"].includes(name),
};

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
 * Parses a JUnit XML report into framework-agnostic tests. JUnit is flat — each test
 * yields a single attempt; the richer `attempts[]` comes from Playwright/Mochawesome.
 */
export function parseJUnit(xml: string, options: RedactOptions = {}): ParsedTest[] {
  const activeParser = HAS_DOCTYPE.test(xml) ? noEntitiesParser : parser;
  const root = activeParser.parse(xml) as XmlNode;
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
