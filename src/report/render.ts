import { type Palette, plainPalette, terminalSafe } from "../colors.js";
import { explainScore } from "./explain.js";
import type { RankedTests, ScoredTest } from "./rank.js";

export interface ReportMeta {
  slug: string;
  /** Total tests scored (eligible + below threshold). */
  totalTests: number;
  /** Human label for the window, e.g. "last 30d"; omitted when reporting all data. */
  windowLabel?: string;
}

export interface RenderOptions {
  /** Max eligible rows to show in the table. */
  limit: number;
  /** Also show below-threshold tests instead of summarizing them in the footer. */
  all: boolean;
}

const TEST_COL = 46;
const COLUMNS =
  " SCORE  TEST                                            RUNS  RETRY%  INTERMIT  MODES  WHY";

/** Renders the ranked report as a terminal table. Color is applied only when `palette` enables it. */
export function renderReport(
  ranked: RankedTests,
  meta: ReportMeta,
  options: RenderOptions,
  palette: Palette = plainPalette,
): string {
  const window = meta.windowLabel ? ` (${meta.windowLabel})` : "";
  const lines = [
    `${palette.heading("Flaky tests")} · ${palette.repo(meta.slug)} · ${meta.totalTests} tests${window}`,
    "",
  ];

  const shown = ranked.eligible.slice(0, options.limit);
  if (shown.length === 0) {
    lines.push(palette.good("No flaky tests above the min-runs threshold."));
  } else {
    lines.push(palette.dim(COLUMNS), ...shown.map((test) => row(test, palette)));
  }

  if (options.all && ranked.belowThreshold.length > 0) {
    lines.push("", palette.dim(`Below the min-runs threshold (${ranked.belowThreshold.length}):`));
    lines.push(...ranked.belowThreshold.map((test) => row(test, palette)));
  } else if (ranked.belowThreshold.length > 0) {
    lines.push(
      "",
      palette.dim(
        `${ranked.belowThreshold.length} test(s) below the min-runs threshold hidden (--all to show).`,
      ),
    );
  }

  return lines.join("\n");
}

// Each column is padded to its visible width *before* coloring, so the ANSI escapes never
// throw off alignment.
function row(test: ScoredTest, palette: Palette): string {
  const { aggregate, score } = test;
  const name = truncate(label(test), TEST_COL).padEnd(TEST_COL);
  const scoreCol = palette.score(String(score.score).padStart(5), score.score);
  const runs = palette.dim(String(score.eligibleRuns).padStart(5));
  const retry = palette.signal(`${retryPercent(test)}%`.padStart(6), aggregate.flakyRuns > 0);
  const intermit = palette.signal(
    `${aggregate.intermittentShas}/${aggregate.distinctShas}`.padStart(8),
    aggregate.intermittentShas > 0,
  );
  const modes = palette.signal(
    String(aggregate.fingerprints).padStart(5),
    aggregate.fingerprints > 1,
  );
  const line = ` ${scoreCol}  ${name}  ${runs}  ${retry}  ${intermit}  ${modes}`;
  const why = explainScore(aggregate, score);
  return why ? `${line}  ${palette.dim(why)}` : line;
}

/** Plain pass-after-retry share of passed + failed runs, matching the other count columns. */
export function retryPercent({ aggregate, score }: ScoredTest): number {
  return score.eligibleRuns > 0 ? Math.round((aggregate.flakyRuns / score.eligibleRuns) * 100) : 0;
}

/** `file › describe › test [cell]` — the matrix cell is appended only when grouping by matrix. */
function label(test: ScoredTest): string {
  const path = [test.aggregate.file, ...test.aggregate.title_path].join(" › ");
  const matrix = test.aggregate.matrix;
  if (matrix && Object.keys(matrix).length > 0) {
    const cell = Object.entries(matrix)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return terminalSafe(`${path} [${cell}]`);
  }
  return terminalSafe(path);
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

/** Renders the full scored set as JSON (eligible first), for piping into other tools. */
export function renderReportJson(ranked: RankedTests): string {
  const rows = [...ranked.eligible, ...ranked.belowThreshold].map((test) => ({
    id: test.aggregate.id,
    file: test.aggregate.file,
    title_path: test.aggregate.title_path,
    framework: test.aggregate.framework,
    ...(test.aggregate.matrix ? { matrix: test.aggregate.matrix } : {}),
    score: test.score.score,
    raw_score: test.score.rawScore,
    confidence: test.score.confidence,
    eligible: test.score.eligible,
    eligible_runs: test.score.eligibleRuns,
    signals: test.score.signals,
    top_signal: test.score.topSignal ?? null,
    reason: explainScore(test.aggregate, test.score),
    totals: {
      runs: test.aggregate.totalRuns,
      passed: test.aggregate.passed,
      failed: test.aggregate.failed,
      skipped: test.aggregate.skipped,
      flaky_runs: test.aggregate.flakyRuns,
    },
    first_seen: test.aggregate.firstSeen,
    last_seen: test.aggregate.lastSeen,
  }));
  return JSON.stringify(rows, null, 2);
}
