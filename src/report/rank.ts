import type { TestAggregate } from "./aggregate.js";
import { type FlakeScore, type ScoreOptions, scoreTest } from "./score.js";

/** An aggregated test paired with its flake score. */
export interface ScoredTest {
  aggregate: TestAggregate;
  score: FlakeScore;
}

export interface RankedTests {
  /** Eligible tests (≥ minRuns), highest score first. */
  eligible: ScoredTest[];
  /** Tests below the min-runs threshold — too small a sample to rank, kept aside. */
  belowThreshold: ScoredTest[];
}

/**
 * Scores every aggregate and splits them into the rankable (eligible) set, sorted by score
 * descending, and the below-threshold set held aside. Ties break by more eligible runs (more
 * evidence first), then test id for stability.
 */
export function rankTests(aggregates: TestAggregate[], options: ScoreOptions = {}): RankedTests {
  const scored = aggregates.map((aggregate) => ({
    aggregate,
    score: scoreTest(aggregate, options),
  }));

  const eligible = scored.filter((test) => test.score.eligible).sort(byScoreThenEvidence);
  const belowThreshold = scored.filter((test) => !test.score.eligible).sort(byScoreThenEvidence);

  return { eligible, belowThreshold };
}

function byScoreThenEvidence(a: ScoredTest, b: ScoredTest): number {
  if (a.score.score !== b.score.score) {
    return b.score.score - a.score.score;
  }
  if (a.score.eligibleRuns !== b.score.eligibleRuns) {
    return b.score.eligibleRuns - a.score.eligibleRuns;
  }
  return a.aggregate.id < b.aggregate.id ? -1 : 1;
}

/**
 * Parses a `--since` window into the earliest run-start to include: a relative `Nd`/`Nh`
 * span from `now`, or an absolute ISO timestamp. Returns undefined for no filter; throws on
 * anything unparseable so a typo never silently widens the window.
 */
export function parseSince(value: string | undefined, now: Date = new Date()): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const relative = /^(\d+)([dh])$/.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unitHours = relative[2] === "d" ? 24 : 1;
    return new Date(now.getTime() - amount * unitHours * 60 * 60 * 1000);
  }

  const iso = /^\d{4}-\d{2}-\d{2}(?:T\S+)?$/.test(value.trim());
  const absolute = new Date(value.trim());
  if (!iso || Number.isNaN(absolute.getTime())) {
    throw new Error(
      `Invalid --since "${value}": expected an ISO timestamp or a span like 30d or 12h.`,
    );
  }
  return absolute;
}
