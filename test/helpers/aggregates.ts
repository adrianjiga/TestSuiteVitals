import type { TestAggregate, WeightedSignals } from "../../src/report/aggregate.js";

/** Fills `weighted` from the plain counts (no decay) unless the row sets it explicitly. */
export function withWeights(
  row: Omit<TestAggregate, "weighted"> & { weighted?: WeightedSignals },
): TestAggregate {
  return {
    ...row,
    weighted: row.weighted ?? {
      passed: row.passed,
      failed: row.failed,
      flakyRuns: row.flakyRuns,
      distinctShas: row.distinctShas,
      intermittentShas: row.intermittentShas,
      flips: row.flips,
      flipPairs: row.flipPairs,
      fingerprints: row.fingerprints,
    },
  };
}
