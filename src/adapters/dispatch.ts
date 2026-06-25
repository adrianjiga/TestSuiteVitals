import type { RedactOptions } from "../events/error.js";
import type { ParsedTest } from "../events/event.js";
import { JUNIT_FRAMEWORK, looksLikeJUnit, parseJUnit } from "./junit.js";
import {
  looksLikePlaywrightBlob,
  PLAYWRIGHT_FRAMEWORK,
  parsePlaywrightBlob,
} from "./playwright-blob.js";

export interface DetectedReport {
  framework: string;
  tests: ParsedTest[];
}

/**
 * Sniffs report content and parses it with the matching adapter, or returns null if no
 * adapter recognizes it. Each adapter emits the same `ParsedTest` shape; Mochawesome is
 * added next in M2.
 */
export function detectAndParse(
  content: string,
  options: RedactOptions = {},
): DetectedReport | null {
  if (looksLikeJUnit(content)) {
    return { framework: JUNIT_FRAMEWORK, tests: parseJUnit(content, options) };
  }
  if (looksLikePlaywrightBlob(content)) {
    return { framework: PLAYWRIGHT_FRAMEWORK, tests: parsePlaywrightBlob(content, options) };
  }
  return null;
}
