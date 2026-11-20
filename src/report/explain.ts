import type { TestAggregate } from "./aggregate.js";
import type { FlakeScore } from "./score.js";

/**
 * A short phrase naming what drove a score, from the plain counts the report shows, e.g.
 * `flips 9/40` or `3 retry-passes`. Empty when no signal contributed.
 */
export function explainScore(aggregate: TestAggregate, score: FlakeScore): string {
  switch (score.topSignal) {
    case "retryFlakeRate":
      return `${aggregate.flakyRuns} retry-pass${aggregate.flakyRuns === 1 ? "" : "es"}`;
    case "flipRate":
      return `flips ${aggregate.flips}/${aggregate.flipPairs}`;
    case "intermittenceRate":
      return `pass+fail on ${aggregate.intermittentShas}/${aggregate.distinctShas} commits`;
    case "diversity":
      return `${aggregate.fingerprints} failure modes`;
    default:
      return "";
  }
}
