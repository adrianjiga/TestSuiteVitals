import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./repo.js";

/**
 * Fetches a text file from the default branch, or null if it does not exist. Used by `doctor`
 * to read manifests (`package.json`, build files) for framework detection. A 404 is an expected
 * "not present" answer, not an error.
 */
export async function getRepoFile(
  octokit: Octokit,
  ref: RepoRef,
  path: string,
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path,
    });
    const data = response.data;
    if (!Array.isArray(data) && data.type === "file") {
      return Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
    }
    return null;
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
}

/** True if any of the given paths exists in the repo (a cheap presence check via a metadata read). */
export async function repoHasFile(
  octokit: Octokit,
  ref: RepoRef,
  paths: string[],
): Promise<boolean> {
  for (const path of paths) {
    try {
      await octokit.rest.repos.getContent({ owner: ref.owner, repo: ref.repo, path });
      return true;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        throw error;
      }
    }
  }
  return false;
}
