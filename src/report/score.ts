import type { TestAggregate } from "./aggregate.js";

/** Below this many eligible runs a sample is too small to rank (1-of-2 is not "50% flaky"). */
export const DEFAULT_MIN_RUNS = 5;

/** Prior strength of the confidence discount: a test needs this many runs to keep half its score. */
const CONFIDENCE_PRIOR_RUNS = 5;

/** Failure-mode diversity saturates here: this many distinct fingerprints scores the signal 1.0. */
const FINGERPRINT_CAP = 4;

/** Multiplier on the raw flip rate before it is capped at 1 (0017). */
const FLIP_SCALE = 3;

/**
 * Signal weights (sum to 1). Flakiness is *inconsistency*, so the inconsistency signals
 * (pass-after-retry, flips, intermittence) dominate; a consistently-failing test is broken, not
 * flaky, and scores low because none of these fire.
 */
const WEIGHTS = {
  retryFlake: 0.35,
  flip: 0.3,
  intermittence: 0.2,
  diversity: 0.15,
} as const;

/** The normalized 0–1 sub-signals behind a score, kept for display and explanation. */
export interface FlakeSignals {
  /** Share of runs that ended green only after a failed attempt. */
  retryFlakeRate: number;
  /** Share of distinct commits that produced both a pass and a fail. */
  intermittenceRate: number;
  /** Pass↔fail flips per consecutive push/schedule run pair, scaled and capped at 1. */
  flipRate: number;
  /** Diversity of failure modes beyond the first (0 when there is one mode or none). */
  diversity: number;
}

export interface FlakeScore {
  /** 0–100 flakiness score: {@link rawScore} discounted by {@link confidence}. Ranking uses this. */
  score: number;
  /** 0–100 blend of the signals before the small-sample discount. */
  rawScore: number;
  /** `eligibleRuns / (eligibleRuns + 5)`: how much of the raw score the sample size supports. */
  confidence: number;
  /** False when `eligibleRuns < minRuns` — the score exists but the sample is too small to trust. */
  eligible: boolean;
  /** Runs with a definite outcome (passed or failed); skips are excluded. */
  eligibleRuns: number;
  signals: FlakeSignals;
  /** The signal contributing the most points; unset when none contributes. */
  topSignal?: keyof FlakeSignals;
}

export interface ScoreOptions {
  /** Minimum eligible runs to consider the score trustworthy (default {@link DEFAULT_MIN_RUNS}). */
  minRuns?: number;
}

/**
 * Scores one aggregated test for flakiness (0–100). The score blends inconsistency signals and
 * shrinks the blend toward 0 for small samples; a test that always passes, or always fails the
 * same way, scores ~0. Scores below `minRuns` eligible runs are still returned but flagged
 * `eligible: false` so the report can set them aside.
 */
export function scoreTest(aggregate: TestAggregate, options: ScoreOptions = {}): FlakeScore {
  const minRuns = options.minRuns ?? DEFAULT_MIN_RUNS;
  const eligibleRuns = aggregate.passed + aggregate.failed;
  const weighted = aggregate.weighted;
  const weightedRuns = weighted.passed + weighted.failed;

  const signals: FlakeSignals = {
    retryFlakeRate: ratio(weighted.flakyRuns, weightedRuns),
    intermittenceRate: ratio(weighted.intermittentShas, weighted.distinctShas),
    flipRate: Math.min(1, FLIP_SCALE * ratio(weighted.flips, weighted.flipPairs)),
    diversity: diversity(weighted.fingerprints),
  };

  const contributions: [keyof FlakeSignals, number][] = [
    ["retryFlakeRate", WEIGHTS.retryFlake * signals.retryFlakeRate],
    ["flipRate", WEIGHTS.flip * signals.flipRate],
    ["intermittenceRate", WEIGHTS.intermittence * signals.intermittenceRate],
    ["diversity", WEIGHTS.diversity * signals.diversity],
  ];
  const raw = contributions.reduce((sum, [, points]) => sum + points, 0);
  const [topSignal, topPoints] = contributions.reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  );

  const confidence = eligibleRuns / (eligibleRuns + CONFIDENCE_PRIOR_RUNS);

  return {
    score: Math.round(raw * confidence * 100),
    rawScore: Math.round(raw * 100),
    confidence,
    eligible: eligibleRuns >= minRuns,
    eligibleRuns,
    signals,
    ...(topPoints > 0 ? { topSignal } : {}),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Only failure modes *beyond the first* are suspicious: one consistent mode scores 0.
 * `fingerprints` is fractional under age weighting.
 */
function diversity(fingerprints: number): number {
  if (fingerprints <= 1) {
    return 0;
  }
  return Math.min(fingerprints - 1, FINGERPRINT_CAP - 1) / (FINGERPRINT_CAP - 1);
}
