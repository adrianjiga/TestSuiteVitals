import { describe, expect, it } from "vitest";
import { aggregate, type TestAggregate } from "../src/report/aggregate.js";
import { FLAKY_AT } from "../src/report/dashboard.js";
import { scoreTest } from "../src/report/score.js";
import { withWeights } from "./helpers/aggregates.js";
import { ev, failed, hour, seeded } from "./helpers/events.js";

/** Builds a TestAggregate with all-zero signals; override only what a case exercises. */
function agg(over: Partial<TestAggregate> = {}): TestAggregate {
  return withWeights({
    id: "t1",
    file: "a.spec.ts",
    title_path: ["A", "x"],
    framework: "junit",
    totalRuns: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flakyRuns: 0,
    retriedRuns: 0,
    flips: 0,
    flipPairs: 0,
    distinctShas: 0,
    intermittentShas: 0,
    fingerprints: 0,
    firstSeen: "2026-06-01T00:00:00Z",
    lastSeen: "2026-06-01T00:00:00Z",
    ...over,
  });
}

describe("scoreTest", () => {
  it("scores a test that always passes at zero", () => {
    const result = scoreTest(agg({ passed: 10, distinctShas: 10 }));
    expect(result.score).toBe(0);
    expect(result.eligibleRuns).toBe(10);
    expect(result.eligible).toBe(true);
  });

  it("scores a consistently-failing test at zero — broken, not flaky", () => {
    const result = scoreTest(agg({ failed: 10, distinctShas: 10, fingerprints: 1 }));
    expect(result.score).toBe(0);
  });

  it("weights pass-after-retry the heaviest (full retry-flake → 35)", () => {
    const result = scoreTest(agg({ passed: 10, flakyRuns: 10, distinctShas: 10 }));
    expect(result.signals.retryFlakeRate).toBe(1);
    expect(result.rawScore).toBe(35);
  });

  it("counts same-commit intermittence (full intermittence → 20)", () => {
    const result = scoreTest(agg({ passed: 5, failed: 5, distinctShas: 10, intermittentShas: 10 }));
    expect(result.signals.intermittenceRate).toBe(1);
    expect(result.rawScore).toBe(20);
  });

  it("scales flip rate and caps it, so frequent random flips saturate it (→ 30)", () => {
    const coin = scoreTest(agg({ passed: 10, failed: 11, flips: 10, flipPairs: 20 }));
    expect(coin.signals.flipRate).toBe(1);
    expect(coin.rawScore).toBe(30);
    const quarter = scoreTest(agg({ passed: 10, failed: 11, flips: 5, flipPairs: 20 }));
    expect(quarter.signals.flipRate).toBe(0.75);
    // Alternating every run is still capped at 1.
    expect(scoreTest(agg({ passed: 10, failed: 11, flips: 20, flipPairs: 20 })).rawScore).toBe(30);
  });

  it("counts only failure modes beyond the first, and caps diversity", () => {
    expect(scoreTest(agg({ failed: 1, distinctShas: 1, fingerprints: 1 })).signals.diversity).toBe(
      0,
    );
    const saturated = scoreTest(agg({ failed: 4, distinctShas: 4, fingerprints: 4 }));
    expect(saturated.signals.diversity).toBe(1);
    expect(saturated.rawScore).toBe(15);
    // Beyond the cap the signal stays saturated.
    expect(scoreTest(agg({ failed: 9, distinctShas: 9, fingerprints: 9 })).rawScore).toBe(15);
  });

  it("discounts small samples: confidence is n/(n+5) and scales the score", () => {
    const five = scoreTest(agg({ passed: 5, flakyRuns: 5, distinctShas: 5 }));
    expect(five.confidence).toBe(0.5);
    expect(five.rawScore).toBe(35);
    expect(five.score).toBe(18);
    const hundred = scoreTest(agg({ passed: 100, flakyRuns: 100, distinctShas: 100 }));
    expect(hundred.confidence).toBeCloseTo(100 / 105);
    expect(hundred.score).toBe(33);
    expect(scoreTest(agg()).confidence).toBe(0);
  });

  it("bases confidence on the real run count, so age weighting never caps it", () => {
    const weekly = scoreTest(
      agg({
        passed: 50,
        failed: 50,
        flips: 50,
        flipPairs: 99,
        distinctShas: 100,
        weighted: {
          passed: 1.7,
          failed: 1.7,
          flakyRuns: 0,
          distinctShas: 3.4,
          intermittentShas: 0,
          flips: 1.7,
          flipPairs: 3.4,
          fingerprints: 1,
        },
      }),
    );
    expect(weekly.confidence).toBeCloseTo(100 / 105);
    expect(weekly.score).toBeGreaterThanOrEqual(FLAKY_AT);
  });

  it("ranks 20 bad runs out of 100 above 1 out of 5 at the same raw rate", () => {
    const many = scoreTest(agg({ passed: 100, flakyRuns: 20, distinctShas: 100 }));
    const few = scoreTest(agg({ passed: 5, flakyRuns: 1, distinctShas: 5 }));
    expect(many.rawScore).toBe(few.rawScore);
    expect(many.score).toBeGreaterThan(few.score);
  });

  it("records the signal worth the most points as topSignal", () => {
    expect(scoreTest(agg({ passed: 10, distinctShas: 10 })).topSignal).toBeUndefined();
    const flaky = scoreTest(
      agg({ passed: 20, failed: 20, flakyRuns: 2, flips: 10, flipPairs: 39, distinctShas: 40 }),
    );
    expect(flaky.topSignal).toBe("flipRate");
  });

  it("flags samples below the min-runs threshold", () => {
    const small = agg({ passed: 2, failed: 1, distinctShas: 3 });
    expect(scoreTest(small).eligible).toBe(false);
    expect(scoreTest(small, { minRuns: 3 }).eligible).toBe(true);
  });

  it("ranks a flaky test above a broken or stable one", () => {
    const flaky = scoreTest(
      agg({
        passed: 8,
        failed: 2,
        flakyRuns: 6,
        distinctShas: 10,
        intermittentShas: 3,
        fingerprints: 3,
      }),
    );
    const broken = scoreTest(agg({ failed: 10, distinctShas: 10, fingerprints: 1 }));
    const stable = scoreTest(agg({ passed: 10, distinctShas: 10 }));

    expect(flaky.score).toBeGreaterThan(broken.score);
    expect(broken.score).toBe(0);
    expect(stable.score).toBe(0);
  });
});

/** Scores the single row (or the row matching `cell`) an event stream aggregates into. */
function scoreOf(events: ReturnType<typeof ev>[], cell?: string, halfLifeMs?: number) {
  const rows = aggregate(events, {
    byMatrix: cell !== undefined,
    ...(halfLifeMs ? { halfLifeMs } : {}),
  });
  const row = cell === undefined ? rows[0] : rows.find((r) => r.matrix?.browser === cell);
  if (!row) {
    throw new Error("no row");
  }
  return scoreTest(row);
}

/** One push run per hour on main, each on a new commit, with no retries. */
function pushes(outcomes: boolean[], browser?: string) {
  return outcomes.map((pass, i) => {
    const over = {
      ...(browser ? { matrix: { browser } } : {}),
      run: { run_id: i + 1, sha: `c${i}`, started_at: hour(i) },
    };
    return pass ? ev(over) : failed(over);
  });
}

function randomOutcomes(runs: number, failRate: number, seed: number): boolean[] {
  const rand = seeded(seed);
  return Array.from({ length: runs }, () => rand() >= failRate);
}

describe("scoring scenarios", () => {
  it("always fails → ~0 (broken, not flaky)", () => {
    expect(scoreOf(pushes(Array(40).fill(false))).score).toBe(0);
  });

  it("broke once, then fixed → low", () => {
    const outcomes = [...Array(30).fill(true), ...Array(10).fill(false), ...Array(30).fill(true)];
    expect(scoreOf(pushes(outcomes)).score).toBeLessThan(5);
  });

  it("25% random failures, a new commit every run, no retries → flaky", () => {
    const result = scoreOf(pushes(randomOutcomes(200, 0.25, 7)));
    expect(result.signals.retryFlakeRate).toBe(0);
    expect(result.signals.intermittenceRate).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(FLAKY_AT);
  });

  it("healthy test caught in a 're-run all jobs' → 0", () => {
    const events = Array.from({ length: 10 }, (_, i) => [
      ev({ run: { run_id: i + 1, run_attempt: 1, sha: `c${i}`, started_at: hour(2 * i) } }),
      ev({ run: { run_id: i + 1, run_attempt: 2, sha: `c${i}`, started_at: hour(2 * i + 1) } }),
    ]).flat();
    expect(scoreOf(events).score).toBe(0);
  });

  it("flaky three months ago, 200 passes since → low with a 14-day half-life", () => {
    const fourteenDays = 14 * 86_400_000;
    // 100 runs a day apart failing at random, then 200 passes over the next three months.
    const events = [...randomOutcomes(100, 0.25, 3), ...Array(200).fill(true)].map((pass, i) => {
      const over = {
        run: {
          run_id: i + 1,
          sha: `c${i}`,
          started_at: hour(i < 100 ? 24 * i : 2400 + 11 * (i - 100)),
        },
      };
      return pass ? ev(over) : failed(over);
    });
    const undecayed = scoreOf(events);
    const decayed = scoreOf(events, undefined, fourteenDays);
    expect(undecayed.score).toBeGreaterThanOrEqual(5);
    expect(decayed.score).toBeLessThan(2);
  });

  it("flaky in one matrix cell only → flagged in that cell with --by-matrix", () => {
    const events = [
      ...pushes(Array(100).fill(true), "chrome"),
      ...pushes(randomOutcomes(100, 0.25, 11), "firefox"),
    ];
    expect(scoreOf(events, "chrome").score).toBe(0);
    expect(scoreOf(events, "firefox").score).toBeGreaterThanOrEqual(FLAKY_AT);
  });
});
