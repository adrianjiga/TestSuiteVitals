import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Where a resolved GitHub token came from, in precedence order (D8). */
export type TokenSource = "flag" | "env" | "gh-cli";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** Thrown when no token can be resolved from any source. */
export class AuthError extends Error {
  override name = "AuthError";
}

/** Runs `gh auth token`; resolves to the trimmed token, or null if unavailable. */
export type GhTokenRunner = () => Promise<string | null>;

const defaultGhRunner: GhTokenRunner = async () => {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    // gh not installed, not authenticated, or any other failure: treat as absent.
    return null;
  }
};

export interface ResolveTokenOptions {
  /** Explicit token from `--token`; highest precedence. */
  token?: string | undefined;
  /** Environment to read `GITHUB_TOKEN` from. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Runner for the `gh auth token` fallback. Injectable for tests. */
  runGhCli?: GhTokenRunner;
}

/**
 * Resolves a GitHub token using the D8 precedence chain:
 *   --token  →  GITHUB_TOKEN  →  `gh auth token`  →  clear error.
 *
 * Transport stays a single Octokit instance (see client.ts); only token
 * resolution is pluggable, so `gh` users get zero-config auth without us
 * maintaining a second transport.
 */
export async function resolveToken(
  options: ResolveTokenOptions = {},
): Promise<ResolvedToken> {
  const { token, env = process.env, runGhCli = defaultGhRunner } = options;

  const flag = token?.trim();
  if (flag) {
    return { token: flag, source: "flag" };
  }

  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    return { token: fromEnv, source: "env" };
  }

  const fromGh = await runGhCli();
  if (fromGh) {
    return { token: fromGh, source: "gh-cli" };
  }

  throw new AuthError(
    [
      "No GitHub token found. Provide one of:",
      "  • --token <token>",
      "  • GITHUB_TOKEN environment variable",
      "  • authenticate the GitHub CLI: `gh auth login`",
    ].join("\n"),
  );
}
