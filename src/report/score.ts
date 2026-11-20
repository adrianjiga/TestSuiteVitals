import type { TestAggregate } from "./aggregate.js";

/** Below this many eligible runs a sample is too small to rank (1-of-2 is not "50% flaky"). */
export const DEFAULT_MIN_RUNS = 5;

/**
 * Prior strength of the confidence discount: a test needs this many runs to keep half its raw
 * score, so 1 bad run in 5 ranks below 20 in 100.
 */
const CONFIDENCE_PRIOR_RUNS = 5;

/** Failure-mode diversity saturates here: this many distinct fingerprints scores the signal 1.0. */
const FINGERPRINT_CAP = 4;

/**
 * Random failure at rate p flips 2p(1−p) of the time: 0.375 at 25%, 0.18 at 10%. Scaling by 3
 * saturates the signal from about 20% random failure, and lets ~13% cross the flaky line alone.
 */
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
  /**
   * `n / (n + 5)` over the age-weighted passed + failed runs: how much of the raw score the
   * sample supports. Old runs count for less, so a test not run lately loses confidence.
   */
  confidence: number;
  /** False when `eligibleRuns < minRuns` — the score exists but the sample is too small to trust. */
  eligible: boolean;
  /** Runs with a definite outcome (passed or failed); skips are excluded. */
  eligibleRuns: number;
  signals: FlakeSignals;
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

  const raw =
    WEIGHTS.retryFlake * signals.retryFlakeRate +
    WEIGHTS.intermittence * signals.intermittenceRate +
    WEIGHTS.flip * signals.flipRate +
    WEIGHTS.diversity * signals.diversity;

  const confidence = weightedRuns / (weightedRuns + CONFIDENCE_PRIOR_RUNS);

  return {
    score: Math.round(raw * confidence * 100),
    rawScore: Math.round(raw * 100),
    confidence,
    eligible: eligibleRuns >= minRuns,
    eligibleRuns,
    signals,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Only failure modes *beyond the first* are suspicious: one consistent mode scores 0. With age
 * weighting `fingerprints` is fractional, as old modes fade out.
 */
function diversity(fingerprints: number): number {
  if (fingerprints <= 1) {
    return 0;
  }
  return Math.min(fingerprints - 1, FINGERPRINT_CAP - 1) / (FINGERPRINT_CAP - 1);
}
