import type { RunOutcome } from "./aggregate.js";
import type { RankedTests, ScoredTest } from "./rank.js";

export interface DashboardMeta {
  slug: string;
  totalTests: number;
  /** Human label for the window, e.g. "last 30d"; omitted when reporting all data. */
  windowLabel?: string;
  /** ISO timestamp shown in the footer. */
  generatedAt: string;
}

/** Score at or above which a test counts as flaky in the header tally and gets a warning tint. */
export const FLAKY_AT = 20;
/** Most recent outcomes to draw in a sparkline. */
const SPARK_MAX = 24;

/** Per-outcome sparkline bar: a worse outcome is taller and hotter. */
const BAR: Record<RunOutcome, { h: number; c: string }> = {
  passed: { h: 4, c: "var(--ok)" },
  flaky: { h: 10, c: "var(--warn)" },
  failed: { h: 16, c: "var(--bad)" },
  skipped: { h: 3, c: "var(--dim)" },
};

const HEADER_ROW = `    <div class="row head">
      <span class="r-score">score</span>
      <span>test</span>
      <span>recent</span>
      <span>retry</span>
      <span>intermit</span>
      <span>modes</span>
      <span class="r-status">status</span>
    </div>`;

const LEGEND =
  "score 0–100 flakiness · retry pass-after-retry rate · intermit commits that both passed and " +
  "failed · modes distinct failure signatures · recent run outcomes, old → new";

/**
 * Renders a self-contained HTML dashboard (inline CSS, zero runtime dependencies) — the
 * "vital signs" view: a dark monitor with one row per test, ranked by flake score, each with a
 * heartbeat sparkline of its recent run outcomes.
 */
export function renderDashboard(ranked: RankedTests, meta: DashboardMeta): string {
  const flakyCount = ranked.eligible.filter((test) => test.score.score >= FLAKY_AT).length;
  const window = meta.windowLabel ? ` · ${esc(meta.windowLabel)}` : "";

  const eligibleRows =
    ranked.eligible.length > 0
      ? `${HEADER_ROW}\n${ranked.eligible.map(row).join("\n")}`
      : `<div class="empty">No flaky tests above the min-runs threshold — all vitals stable.</div>`;

  const belowSection =
    ranked.belowThreshold.length > 0
      ? `<h2>Below the min-runs threshold (${ranked.belowThreshold.length})</h2>
         <div class="rows muted">${ranked.belowThreshold.map(row).join("\n")}</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suitevitals · ${esc(meta.slug)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div class="brand"><span class="pulse">♥</span> SUITEVITALS</div>
    <div class="repo">${esc(meta.slug)}</div>
    <div class="stats">
      <span>${meta.totalTests} tests</span>
      <span class="${flakyCount > 0 ? "warn" : "ok"}">${flakyCount} flaky</span>
      <span class="muted">${esc(meta.generatedAt)}${window}</span>
    </div>
    <div class="legend">${LEGEND}</div>
  </header>
  <div class="rows">
${eligibleRows}
  </div>
  ${belowSection}
  <footer>Suitevitals — the vital signs of your test suite.</footer>
</main>
</body>
</html>
`;
}

function row(test: ScoredTest): string {
  const { aggregate, score } = test;
  const sev = severity(score.score, score.eligible);
  const retry = Math.round(score.signals.retryFlakeRate * 100);
  const { lead, context, full } = label(test);
  return `    <div class="row ${sev}">
      <span class="score">${score.score}</span>
      <span class="name" title="${esc(full)}"><span class="lead">${esc(lead)}</span><span class="ctx"> — ${esc(context)}</span></span>
      <span class="spark" title="recent runs (old → new)">${sparkline(aggregate.timeline)}</span>
      <span class="sig">${retry}%</span>
      <span class="sig">${aggregate.intermittentShas}/${aggregate.distinctShas}</span>
      <span class="sig">${aggregate.fingerprints}</span>
      <span class="status">${statusLabel(score.score, score.eligible)}</span>
    </div>`;
}

function sparkline(timeline: RunOutcome[] | undefined): string {
  if (!timeline || timeline.length === 0) {
    return `<i class="nodata" title="no timeline"></i>`;
  }
  return timeline
    .slice(-SPARK_MAX)
    .map((outcome) => {
      const bar = BAR[outcome];
      return `<i style="height:${bar.h}px;background:${bar.c}" title="${outcome}"></i>`;
    })
    .join("");
}

/**
 * Splits a test's identity so the *distinguishing* part leads and survives truncation: the
 * deepest title segment (the test name) is the lead; the file and enclosing suites are dim
 * trailing context. `full` is the complete identifier, used as a hover tooltip.
 */
function label(test: ScoredTest): { lead: string; context: string; full: string } {
  const path = test.aggregate.title_path;
  const lead = path.at(-1) ?? test.aggregate.file;
  const suites = path.slice(0, -1);
  const matrix = test.aggregate.matrix;
  const cell =
    matrix && Object.keys(matrix).length > 0
      ? ` [${Object.entries(matrix)
          .map(([k, v]) => `${k}=${v}`)
          .join(",")}]`
      : "";
  const context = [test.aggregate.file, ...suites].join(" › ") + cell;
  return { lead, context, full: `${context} › ${lead}` };
}

function severity(score: number, eligible: boolean): string {
  if (!eligible) {
    return "sev-none";
  }
  return score >= 50 ? "sev-high" : score >= FLAKY_AT ? "sev-mid" : "sev-low";
}

function statusLabel(score: number, eligible: boolean): string {
  if (!eligible) {
    return "low data";
  }
  if (score >= 50) {
    return "flaky";
  }
  if (score >= FLAKY_AT) {
    return "unstable";
  }
  if (score > 0) {
    return "watch";
  }
  return "healthy";
}

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const STYLE = `
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d;
  --text: #c9d1d9; --dim: #8b949e;
  --ok: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #58a6ff;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 60px; }
header { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 4px; }
.brand { font-size: 18px; font-weight: 700; letter-spacing: 2px; }
.pulse { color: var(--bad); }
.repo { color: var(--accent); margin-top: 2px; }
.stats { margin-top: 8px; display: flex; gap: 16px; }
.legend { margin-top: 10px; color: var(--dim); font-size: 11px; }
.rows { display: flex; flex-direction: column; }
.row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 104px 56px 72px 56px 86px;
  align-items: center; gap: 14px;
  padding: 9px 8px; border-bottom: 1px solid var(--border);
}
.row.head { border-bottom: 1px solid var(--border); padding-bottom: 7px; }
.row.head span { color: var(--dim); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
.row.head .r-score, .row.head .r-status { text-align: right; }
.row .score { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.sev-high .score { color: var(--bad); }
.sev-mid .score { color: var(--warn); }
.sev-low .score, .sev-none .score { color: var(--dim); }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name .lead { color: var(--text); }
.name .ctx { color: var(--dim); }
.spark { display: inline-flex; align-items: flex-end; height: 16px; gap: 1px; }
.spark i { display: inline-block; width: 3px; border-radius: 1px; }
.spark .nodata { width: 100%; height: 1px; background: var(--border); }
.sig { color: var(--dim); font-variant-numeric: tabular-nums; }
.status { text-align: right; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
.sev-high .status { color: var(--bad); }
.sev-mid .status { color: var(--warn); }
.sev-low .status { color: var(--ok); }
.sev-none .status { color: var(--dim); }
.muted { color: var(--dim); }
.rows.muted .row { opacity: 0.65; }
h2 { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; margin: 28px 0 4px; font-weight: 600; }
.empty { padding: 24px 8px; color: var(--ok); }
.ok { color: var(--ok); } .warn { color: var(--warn); }
footer { margin-top: 36px; color: var(--dim); font-size: 12px; }
`;
