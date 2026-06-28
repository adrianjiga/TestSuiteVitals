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
const FLAKY_AT = 20;
/** Most recent outcomes to draw in a sparkline. */
const SPARK_MAX = 24;

/** Per-outcome sparkline bar: a worse outcome is taller and hotter. */
const BAR: Record<RunOutcome, { h: number; c: string }> = {
  passed: { h: 4, c: "var(--ok)" },
  flaky: { h: 10, c: "var(--warn)" },
  failed: { h: 16, c: "var(--bad)" },
  skipped: { h: 3, c: "var(--dim)" },
};

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
      ? ranked.eligible.map(row).join("\n")
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
  return `    <div class="row ${sev}">
      <span class="score">${score.score}</span>
      <span class="name"><span class="file">${esc(label(test).file)}</span> › ${esc(label(test).title)}</span>
      <span class="spark" title="recent runs (old → new)">${sparkline(aggregate.timeline)}</span>
      <span class="sig">retry ${retry}%</span>
      <span class="sig">int ${aggregate.intermittentShas}/${aggregate.distinctShas}</span>
      <span class="sig">modes ${aggregate.fingerprints}</span>
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

/** `file` and `title` for a test, with the matrix cell appended to the title when present. */
function label(test: ScoredTest): { file: string; title: string } {
  const path = test.aggregate.title_path.join(" › ");
  const matrix = test.aggregate.matrix;
  const cell =
    matrix && Object.keys(matrix).length > 0
      ? ` [${Object.entries(matrix)
          .map(([k, v]) => `${k}=${v}`)
          .join(",")}]`
      : "";
  return { file: test.aggregate.file, title: `${path}${cell}` };
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
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
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
main { max-width: 920px; margin: 0 auto; padding: 32px 20px 60px; }
header { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 8px; }
.brand { font-size: 18px; font-weight: 700; letter-spacing: 2px; }
.pulse { color: var(--bad); }
.repo { color: var(--accent); margin-top: 2px; }
.stats { margin-top: 8px; display: flex; gap: 16px; color: var(--text); }
.rows { display: flex; flex-direction: column; }
.row {
  display: grid;
  grid-template-columns: 44px 1fr 86px 88px 70px 64px 78px;
  align-items: center; gap: 12px;
  padding: 9px 8px; border-bottom: 1px solid var(--border);
}
.row .score { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.sev-high .score { color: var(--bad); }
.sev-mid .score { color: var(--warn); }
.sev-low .score, .sev-none .score { color: var(--dim); }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name .file { color: var(--dim); }
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
