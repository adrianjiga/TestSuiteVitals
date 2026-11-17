import { compileMatrixPattern } from "../collect/matrix.js";

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

/** Validates `--matrix-from-artifact` the same way a config file's pattern is checked. */
export function parseMatrixFlag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === "") {
    throw new Error(
      `Invalid --matrix-from-artifact "${value}": expected a regex with named groups.`,
    );
  }
  compileMatrixPattern(value, "--matrix-from-artifact");
  return value;
}
