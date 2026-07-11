import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { type ResolveTokenOptions, resolveToken, type TokenSource } from "./auth.js";

export interface GitHubClient {
  /** Base type: the throttling/retry plugins add runtime behavior, not call-site API. */
  octokit: Octokit;
  /** How the token was resolved (D8), for diagnostics in the summary. */
  tokenSource: TokenSource;
}

const USER_AGENT = "suitevitals";

/** How many times to wait-and-retry a single request when GitHub throttles us. */
const MAX_RETRIES = 3;

/**
 * The single transport, hardened with GitHub's official plugins: `throttling`
 * obeys the documented primary/secondary rate-limit headers (wait, then retry),
 * and `retry` backs off on transient 5xx/network errors. Concurrent backfills
 * (p-limit) make hitting these limits likely, so the politeness lives here at the
 * one chokepoint every API call flows through, not at each call site.
 */
const SuitevitalsOctokit = Octokit.plugin(retry, throttling);

/**
 * Builds the single Octokit transport (D8) from a resolved token. Token
 * resolution is delegated to {@link resolveToken}; everything downstream
 * shares this one authenticated client.
 */
export async function createGitHubClient(options: ResolveTokenOptions = {}): Promise<GitHubClient> {
  const { token, source } = await resolveToken(options);
  const octokit = new SuitevitalsOctokit({
    auth: token,
    userAgent: USER_AGENT,
    log: quietLog(),
    throttle: {
      onRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        console.warn(
          `GitHub rate limit hit on ${requestOptions.method} ${requestOptions.url}; ` +
            `waiting ${retryAfter}s before retry ${retryCount + 1}/${MAX_RETRIES}.`,
        );
        return retryCount < MAX_RETRIES;
      },
      onSecondaryRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        console.warn(
          `GitHub secondary rate limit on ${requestOptions.method} ${requestOptions.url}; ` +
            `waiting ${retryAfter}s before retry ${retryCount + 1}/${MAX_RETRIES}.`,
        );
        return retryCount < MAX_RETRIES;
      },
    },
  });
  return { octokit, tokenSource: source };
}

/**
 * Octokit's default logger, minus the bundled request-log plugin's automatic per-request line
 * for 404s (`GET <url> - 404 with id …`). That line merely duplicates the thrown error and turns
 * expected 404s — e.g. `doctor` probing for a maybe-absent `pom.xml` — into console noise; the
 * error itself still propagates and is handled by the caller. Other statuses (401/403/5xx) keep
 * their log line — those are never "expected", and the line is a diagnostic worth having. Real
 * rate-limit warnings (emitted via `console.warn` in the throttle callbacks) are untouched.
 */
function quietLog() {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
    error: (message: string, ...args: unknown[]) => {
      if (/ - 404 with id /.test(message)) {
        return;
      }
      console.error(message, ...args);
    },
  };
}
