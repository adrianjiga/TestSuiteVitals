import { createHash } from "node:crypto";
import type { TestError } from "./event.js";

/** Default truncation budget for error messages (D6). */
export const DEFAULT_ERROR_LIMIT = 400;

export interface RedactOptions {
  /** Bypass both redaction and truncation (`--full-errors`). */
  fullErrors?: boolean;
  /** Truncation budget in characters; the first line is always kept whole. */
  limit?: number;
}

/** Key names whose values are secrets, in `key=value`, `key: value`, JSON and CLI-flag forms. */
const SECRET_KEYS =
  "password|passwd|passphrase|pwd|secret|client[_-]?secret|token|access[_-]?token|auth[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key";

/** Text glued to a closing quote, up to the delimiter that ends a JSON/CLI/connection field. */
const GLUED = "[^\\s,;})\\]]*";

/**
 * A secret value: a quoted string (spaces and backslash-escaped quotes included, plus anything
 * glued to its closing quote up to a field delimiter), else everything up to whitespace.
 * Stopping at an escaped quote would leave the rest of a value like `"ab\\"cd ef"` stored.
 */
const SECRET_VALUE = `("(?:[^"\\\\]|\\\\.)*"${GLUED}|'(?:[^'\\\\]|\\\\.)*'${GLUED}|\\S+)`;

/** Patterns for secrets that must never be stored (D6). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM private-key blocks (connection failures love to dump these whole).
  [/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?(?:-{5}END [A-Z ]*PRIVATE KEY-{5}|$)/g, "[REDACTED]"],
  // Known token shapes: GitHub PATs, OAuth, Slack, AWS access keys.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  // GitLab PATs, npm automation tokens, OpenAI-style sk- keys (length floors keep short
  // identifiers like CSS class names untouched).
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]"],
  // Stripe live/test keys and Google API keys.
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  // Bare JWTs: three base64url segments, the first always starting eyJ ('{"').
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  // Credentials in a URL authority: scheme://user:pass@host (connection strings).
  [/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@"],
  // Bearer/Basic auth headers (covers the Authorization header case).
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/g, "$1 [REDACTED]"],
  // CLI flags taking the secret as the next argument: `--password hunter2`.
  [new RegExp(`(--?(?:${SECRET_KEYS}))\\s+${SECRET_VALUE}`, "gi"), "$1 [REDACTED]"],
  // key=value / key: value / "key": "value" secrets, quoted values kept whole.
  [new RegExp(`\\b(${SECRET_KEYS})\\b(["']?\\s*[=:]\\s*)${SECRET_VALUE}`, "gi"), "$1$2[REDACTED]"],
  // Query-string values (URLs often carry signed tokens).
  [/([?&][^=\s&]+=)[^\s&]+/g, "$1[REDACTED]"],
];

/** Removes known secret shapes from text. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text,
  );
}

/**
 * Truncates over-long text (D6). When the text spans multiple lines, only the first line is
 * kept — failure messages put the signal on line one and the bloat (HTML dumps, response
 * bodies) on later lines. The kept portion is always hard-capped at `limit`: a single-line
 * dump *is* the bloat (minified HTML on line one is common, and a hostile report can put
 * megabytes there), so the budget must hold with or without a newline.
 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const newline = text.indexOf("\n");
  const keep = newline === -1 ? limit : Math.min(newline, limit);
  return `${text.slice(0, keep)} …[truncated]`;
}

/** Redacts then truncates a message, unless `fullErrors` bypasses both (D6). */
export function redactError(message: string, options: RedactOptions = {}): string {
  const { fullErrors = false, limit = DEFAULT_ERROR_LIMIT } = options;
  if (fullErrors) {
    return message;
  }
  return truncate(redactSecrets(message), limit);
}

/** Masks volatile detail (paths, line/col numbers, timestamps, addresses) from a stack. */
export function normalizeStack(stack: string): string {
  return stack
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<TS>")
    .replace(/0x[0-9a-fA-F]+/g, "<ADDR>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:)]+)+/g, "<PATH>")
    .replace(/:\d+(?::\d+)?/g, ":<N>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fingerprints a failure by hashing its normalized stack (D7). Two failures with
 * the same shape but different paths/line numbers/timestamps share a fingerprint,
 * which is what lets the tool say "these 14 failures are the same failure".
 */
export function fingerprint(stack: string): string {
  return createHash("sha256").update(normalizeStack(stack)).digest("hex").slice(0, 12);
}

export interface RawError {
  /** Short failure message (the `message` attribute / first line). */
  message: string;
  /** Detail/stack body used for fingerprinting; falls back to the message. */
  stack?: string;
}

/** Builds a stored {@link TestError}: redacted message + stack fingerprint. */
export function makeTestError(raw: RawError, options: RedactOptions = {}): TestError {
  return {
    message: redactError(raw.message, options),
    fingerprint: fingerprint(raw.stack && raw.stack.trim().length > 0 ? raw.stack : raw.message),
  };
}
