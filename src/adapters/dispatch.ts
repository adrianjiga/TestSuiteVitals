import type { RedactOptions } from "../events/error.js";
import type { ParsedTest } from "../events/event.js";
import { JUNIT_FRAMEWORK, looksLikeJUnit, parseJUnit } from "./junit.js";

export interface DetectedReport {
  framework: string;
  tests: ParsedTest[];
}

/**
 * Sniffs report content and parses it with the matching adapter, or returns null
 * if no adapter recognizes it. JUnit only for now; Playwright JSON and Mochawesome
 * (which read the same `ParsedTest` shape) are added in M2.
 */
export function detectAndParse(
  content: string,
  options: RedactOptions = {},
): DetectedReport | null {
  if (looksLikeJUnit(content)) {
    return { framework: JUNIT_FRAMEWORK, tests: parseJUnit(content, options) };
  }
  return null;
}
