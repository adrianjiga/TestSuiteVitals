/**
 * Deriving a matrix cell from the artifact an extracted report came from.
 *
 * Playwright blob reports carry their own matrix (the project name), so the adapter sets it
 * per test and this never applies. JUnit and mochawesome carry none — but a CI matrix job
 * uploads its results under its own artifact name (`cypress-results-ui-firefox-desktop`), so
 * the name is the cell.
 *
 * This matters beyond labelling. The dedup key is `(run_id, run_attempt, id, matrix)`, so an
 * empty matrix makes every cell's result for one test share a key: the first written wins and
 * the rest are dropped as duplicates. A test failing only on Firefox is then undetectable —
 * the Chrome pass and the Firefox failure collapse into one arbitrary survivor.
 *
 * The matrix is never part of test identity (D5), so populating it re-keys dedup but never
 * `id` — history stays attached to the same test.
 */

/** A compiled `matrixFromArtifact` pattern. */
export type MatrixPattern = RegExp;

/**
 * Compiles a `matrixFromArtifact` pattern. The pattern must declare at least one **named**
 * group — the group names become the matrix dimensions, so an unnamed pattern could not
 * produce a cell and is far more likely a mistake than an intent.
 *
 * @throws if the pattern is not valid regex, or declares no named groups.
 */
export function compileMatrixPattern(pattern: string, where = "matrixFromArtifact"): MatrixPattern {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `Invalid ${where}: not a valid regular expression (${(error as Error).message}).`,
    );
  }
  if (!/\(\?<[A-Za-z_$][\w$]*>/.test(pattern)) {
    throw new Error(
      `Invalid ${where}: the pattern must declare at least one named group, ` +
        `e.g. "results-(?<browser>[^-]+)" — group names become the matrix dimensions.`,
    );
  }
  return regex;
}

/**
 * Resolves the matrix cell for a report file, given the artifact it was extracted from.
 *
 * With a pattern: the named groups that participated in the match become the dimensions. A
 * non-matching artifact falls back to the opaque form rather than being dropped — a report is
 * evidence, and silently discarding it because a pattern was mistyped is the failure mode this
 * whole module exists to prevent.
 *
 * Without a pattern: `{ artifact: <name> }`. Verbose, but it is a fact rather than an
 * inference, and it keeps distinct cells distinct under the dedup key.
 */
export function matrixForArtifact(
  artifact: string,
  pattern?: MatrixPattern,
): Record<string, string> {
  if (pattern) {
    const groups = pattern.exec(artifact)?.groups;
    if (groups) {
      const cell: Record<string, string> = {};
      for (const [key, value] of Object.entries(groups)) {
        // An optional group that did not participate is absent, not empty — omit it so two
        // artifacts differing only in an unmatched optional group share one cell.
        if (value !== undefined) {
          cell[key] = value;
        }
      }
      if (Object.keys(cell).length > 0) {
        return cell;
      }
    }
  }
  return { artifact };
}
