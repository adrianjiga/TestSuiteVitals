/**
 * Collects every `--repo` value from the raw argv. citty's parsed `args.repo` keeps only the
 * last occurrence of a repeated string flag, so reading the raw args is the only way to see
 * them all — both for multi-repo `collect` and to detect misuse in single-repo `report`.
 * Handles both `--repo owner/name` and `--repo=owner/name`.
 */
export function parseRepoFlags(rawArgs: string[]): string[] {
  const repos: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--repo") {
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        repos.push(next);
        i++;
      }
    } else if (arg?.startsWith("--repo=")) {
      repos.push(arg.slice("--repo=".length));
    }
  }
  return repos;
}
