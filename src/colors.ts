import pc from "picocolors";

/**
 * A semantic terminal palette: callers express *intent* (a heading, a score, a warning) rather
 * than raw colors, so coloring stays consistent and is trivially disabled. A disabled palette
 * returns every string unchanged, so rendering logic and tests are colorless by default.
 */
export interface Palette {
  heading(text: string): string;
  repo(text: string): string;
  dim(text: string): string;
  good(text: string): string;
  warn(text: string): string;
  bad(text: string): string;
  /** Colors a score by severity: red+bold ≥ 50, yellow ≥ 20, dim below. */
  score(text: string, value: number): string;
  /** A signal column: yellow when it has a non-zero value, dim when quiet. */
  signal(text: string, active: boolean): string;
}

export function createPalette(enabled: boolean): Palette {
  const c = pc.createColors(enabled);
  return {
    heading: (text) => c.bold(text),
    repo: (text) => c.cyan(text),
    dim: (text) => c.dim(text),
    good: (text) => c.green(text),
    warn: (text) => c.yellow(text),
    bad: (text) => c.red(text),
    score: (text, value) =>
      value >= 50 ? c.bold(c.red(text)) : value >= 20 ? c.yellow(text) : c.dim(text),
    signal: (text, active) => (active ? c.yellow(text) : c.dim(text)),
  };
}

/** Whether to emit color, per picocolors' TTY / `NO_COLOR` / `FORCE_COLOR` detection. */
export const colorSupported: boolean = pc.isColorSupported;

/** No-op palette — the default for pure rendering and tests. */
export const plainPalette: Palette = createPalette(false);
