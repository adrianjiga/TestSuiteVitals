export interface RepoRef {
  owner: string;
  repo: string;
}

/** GitHub owner/repo segment: letters, digits, dot, dash, underscore. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parses an `owner/name` string into its parts. Throws on anything that is not exactly two
 * non-empty, validly-charactered segments. `.` and `..` are rejected explicitly — GitHub
 * never issues them, and since segments feed filesystem paths (the `data/` layout), letting
 * them through would hand path semantics to user input (F7).
 */
export function parseRepoRef(value: string): RepoRef {
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repo "${value}": expected the form owner/name.`);
  }
  const [owner, repo] = parts;
  if (!owner || !repo || !isValidSegment(owner) || !isValidSegment(repo)) {
    throw new Error(`Invalid repo "${value}": expected the form owner/name.`);
  }
  return { owner, repo };
}

function isValidSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/** Canonical `owner/name` string, used as the key into state.repos. */
export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}
