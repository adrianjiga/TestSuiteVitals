import { optionalPattern, optionalString } from "../collect/config.js";

/** Splits a comma-separated flag list (`--exclude-trigger`, `--exclude-artifact`). */
export function parseCommaList(
  value: string | undefined,
  flag: string,
  expected: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    throw new Error(`Invalid ${flag} "${value}": expected ${expected}.`);
  }
  return items;
}

/** Validates `--workflow` with the rule a config file's `workflow` follows. */
export function parseWorkflowFlag(value: string | undefined): string | undefined {
  return optionalString(value, "--workflow");
}

/** Validates `--matrix-from-artifact` with the rule a config file's pattern follows. */
export function parseMatrixFlag(value: string | undefined): string | undefined {
  return optionalPattern(value, "--matrix-from-artifact");
}
