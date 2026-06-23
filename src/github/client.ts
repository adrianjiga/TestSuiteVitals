import { Octokit } from "@octokit/rest";
import { resolveToken, type ResolveTokenOptions, type TokenSource } from "./auth.js";

export interface GitHubClient {
  octokit: Octokit;
  /** How the token was resolved (D8), for diagnostics in the summary. */
  tokenSource: TokenSource;
}

const USER_AGENT = "suitevitals";

/**
 * Builds the single Octokit transport (D8) from a resolved token. Token
 * resolution is delegated to {@link resolveToken}; everything downstream
 * shares this one authenticated client.
 */
export async function createGitHubClient(
  options: ResolveTokenOptions = {},
): Promise<GitHubClient> {
  const { token, source } = await resolveToken(options);
  const octokit = new Octokit({ auth: token, userAgent: USER_AGENT });
  return { octokit, tokenSource: source };
}
