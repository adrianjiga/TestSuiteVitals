import { readFile } from "node:fs/promises";
import { parseRepoRef, type RepoRef, repoSlug } from "../github/repo.js";

/** A repo entry in a config file: a bare `owner/name`, or an object with per-repo overrides. */
export interface RepoConfigEntry {
  repo: string;
  hoursBack?: number;
  concurrency?: number;
}

/** A parsed `--config` file: a repo list plus optional defaults applied to every repo. */
export interface RepoConfig {
  hoursBack?: number;
  concurrency?: number;
  repos: (string | RepoConfigEntry)[];
}

/** A fully-resolved collection target: one repo with its effective settings. */
export interface CollectTarget {
  ref: RepoRef;
  slug: string;
  hoursBack?: number;
  concurrency: number;
}

export interface ResolveTargetsInput {
  /** Repos passed on the CLI via (repeatable) `--repo`. */
  cliRepos: string[];
  /** `--hours-back` from the CLI, if any. */
  cliHoursBack?: number;
  /** `--concurrency` from the CLI, if any. */
  cliConcurrency?: number;
  /** Parsed `--config` file, if one was given. */
  config?: RepoConfig;
  /** Built-in concurrency default when nothing else sets it. */
  defaultConcurrency: number;
}

/**
 * Reads and validates a JSON config file. The shape is `{ hoursBack?, concurrency?, repos[] }`,
 * where each `repos[]` entry is `"owner/name"` or `{ repo, hoursBack?, concurrency? }`. Validation
 * is strict so a typo surfaces immediately rather than silently collecting the wrong repos.
 */
export async function loadConfig(path: string): Promise<RepoConfig> {
  const raw = await readFile(path, "utf8");
  return parseConfig(raw, path);
}

/** Pure parse+validate of config JSON, separated from I/O for testing. */
export function parseConfig(raw: string, source = "config"): RepoConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid config ${source}: not valid JSON (${(error as Error).message}).`);
  }
  if (!isObject(data)) {
    throw new Error(`Invalid config ${source}: expected a JSON object.`);
  }

  const repos = data.repos;
  if (!Array.isArray(repos)) {
    throw new Error(`Invalid config ${source}: "repos" must be an array.`);
  }

  return {
    hoursBack: optionalHoursBack(data.hoursBack, `${source} hoursBack`),
    concurrency: optionalConcurrency(data.concurrency, `${source} concurrency`),
    repos: repos.map((entry, i) => parseEntry(entry, `${source} repos[${i}]`)),
  };
}

function parseEntry(entry: unknown, where: string): string | RepoConfigEntry {
  if (typeof entry === "string") {
    return entry;
  }
  if (!isObject(entry) || typeof entry.repo !== "string") {
    throw new Error(`Invalid config ${where}: expected "owner/name" or an object with "repo".`);
  }
  return {
    repo: entry.repo,
    hoursBack: optionalHoursBack(entry.hoursBack, `${where} hoursBack`),
    concurrency: optionalConcurrency(entry.concurrency, `${where} concurrency`),
  };
}

/**
 * Merges CLI repos and config repos into the final target list. Precedence per field is
 * most-specific-wins: a per-repo config value beats the CLI flag, which beats the config-level
 * default, which beats the built-in. Config repos come first (in file order), then any
 * CLI-only repos; a repo named in both is de-duplicated to its config entry. Throws if the
 * merge yields no repos.
 */
export function resolveTargets(input: ResolveTargetsInput): CollectTarget[] {
  const { cliRepos, cliHoursBack, cliConcurrency, config, defaultConcurrency } = input;
  const targets: CollectTarget[] = [];
  const seen = new Set<string>();

  const add = (repo: string, perRepo: { hoursBack?: number; concurrency?: number }) => {
    const ref = parseRepoRef(repo);
    const slug = repoSlug(ref);
    if (seen.has(slug)) {
      return;
    }
    seen.add(slug);
    targets.push({
      ref,
      slug,
      hoursBack: perRepo.hoursBack ?? cliHoursBack ?? config?.hoursBack,
      concurrency:
        perRepo.concurrency ?? cliConcurrency ?? config?.concurrency ?? defaultConcurrency,
    });
  };

  for (const entry of config?.repos ?? []) {
    if (typeof entry === "string") {
      add(entry, {});
    } else {
      add(entry.repo, { hoursBack: entry.hoursBack, concurrency: entry.concurrency });
    }
  }
  for (const repo of cliRepos) {
    add(repo, {});
  }

  if (targets.length === 0) {
    throw new Error("No repositories to collect: pass --repo or list repos in --config.");
  }
  return targets;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalHoursBack(value: unknown, where: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${where}: expected a positive number.`);
  }
  return value;
}

function optionalConcurrency(value: unknown, where: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${where}: expected a positive integer.`);
  }
  return value;
}
