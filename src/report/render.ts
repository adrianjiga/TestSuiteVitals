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
  " SCORE  TEST                                            RUNS  RETRY%  INTERMIT  MODES";

/** Renders the ranked report as a terminal table. */
export function renderReport(
  ranked: RankedTests,
  meta: ReportMeta,
  options: RenderOptions,
): string {
  const window = meta.windowLabel ? ` (${meta.windowLabel})` : "";
  const lines = [`Flaky tests · ${meta.slug} · ${meta.totalTests} tests${window}`, ""];

  const shown = ranked.eligible.slice(0, options.limit);
  if (shown.length === 0) {
    lines.push("No flaky tests above the min-runs threshold.");
  } else {
    lines.push(COLUMNS, ...shown.map(row));
  }

  if (options.all && ranked.belowThreshold.length > 0) {
    lines.push("", `Below the min-runs threshold (${ranked.belowThreshold.length}):`);
    lines.push(...ranked.belowThreshold.map(row));
  } else if (ranked.belowThreshold.length > 0) {
    lines.push(
      "",
      `${ranked.belowThreshold.length} test(s) below the min-runs threshold hidden (--all to show).`,
    );
  }

  return lines.join("\n");
}

function row(test: ScoredTest): string {
  const { aggregate, score } = test;
  const name = truncate(label(test), TEST_COL).padEnd(TEST_COL);
  const scoreCol = String(score.score).padStart(5);
  const runs = String(score.eligibleRuns).padStart(5);
  const retry = `${Math.round(score.signals.retryFlakeRate * 100)}%`.padStart(6);
  const intermit = `${aggregate.intermittentShas}/${aggregate.distinctShas}`.padStart(8);
  const modes = String(aggregate.fingerprints).padStart(5);
  return ` ${scoreCol}  ${name}  ${runs}  ${retry}  ${intermit}  ${modes}`;
}

/** `file › describe › test [cell]` — the matrix cell is appended only when grouping by matrix. */
function label(test: ScoredTest): string {
  const path = [test.aggregate.file, ...test.aggregate.title_path].join(" › ");
  const matrix = test.aggregate.matrix;
  if (matrix && Object.keys(matrix).length > 0) {
    const cell = Object.entries(matrix)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${path} [${cell}]`;
  }
  return path;
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
    eligible: test.score.eligible,
    eligible_runs: test.score.eligibleRuns,
    signals: test.score.signals,
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
