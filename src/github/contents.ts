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
      // Files over ~1 MB come back with `encoding: "none"` and empty content; treat them as
      // unreadable rather than crashing on the unknown encoding (F6). Manifests that large
      // carry no framework signal worth chasing through the blobs API.
      if (data.encoding !== "base64" && data.encoding !== "utf-8") {
        return null;
      }
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

/**
 * Lists every blob path on the repo's default branch via the git trees API, or null when the
 * tree is unavailable (404), the repo is empty (409), or the listing was truncated (huge repos)
 * — callers fall back to root-only probing. One request replaces per-path existence probes and
 * lets `doctor` see manifests in monorepo subdirectories.
 */
export async function listRepoTree(octokit: Octokit, ref: RepoRef): Promise<string[] | null> {
  try {
    const { data: repo } = await octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo });
    const { data } = await octokit.rest.git.getTree({
      owner: ref.owner,
      repo: ref.repo,
      tree_sha: repo.default_branch,
      recursive: "1",
    });
    if (data.truncated) {
      return null;
    }
    return data.tree.flatMap((entry) => (entry.type === "blob" && entry.path ? [entry.path] : []));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 409) {
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
