import { readFile } from "node:fs/promises";
import { parseRepoRef, type RepoRef, repoSlug } from "../github/repo.js";
import { compileMatrixPattern } from "./matrix.js";

/** A repo entry in a config file: a bare `owner/name`, or an object with per-repo overrides. */
export interface RepoConfigEntry {
  repo: string;
  hoursBack?: number;
  concurrency?: number;
  workflow?: string;
  excludeTriggers?: string[];
  /** Regex with named groups; group names become matrix dimensions read from artifact names. */
  matrixFromArtifact?: string;
  /** Artifact-name globs to skip entirely (e.g. a merged roll-up that repeats per-cell results). */
  excludeArtifacts?: string[];
}

/** A parsed `--config` file: a repo list plus optional defaults applied to every repo. */
export interface RepoConfig {
  hoursBack?: number;
  concurrency?: number;
  workflow?: string;
  excludeTriggers?: string[];
  /** Default matrix pattern applied to every repo that does not override it. */
  matrixFromArtifact?: string;
  /** Default artifact-name globs to skip, applied to every repo that does not override them. */
  excludeArtifacts?: string[];
  repos: (string | RepoConfigEntry)[];
}

/** A fully-resolved collection target: one repo with its effective settings. */
export interface CollectTarget {
  ref: RepoRef;
  slug: string;
  hoursBack?: number;
  concurrency: number;
  /** Only collect runs of workflows matching this glob (`*` wildcard). */
  workflow?: string;
  /** Skip runs fired by these trigger events. */
  excludeTriggers?: string[];
  /** Regex whose named groups name the matrix dimensions read out of each artifact name. */
  matrixFromArtifact?: string;
  /** Artifact-name globs dropped before download. */
  excludeArtifacts?: string[];
}

export interface ResolveTargetsInput {
  /** Repos passed on the CLI via (repeatable) `--repo`. */
  cliRepos: string[];
  /** `--hours-back` from the CLI, if any. */
  cliHoursBack?: number;
  /** `--concurrency` from the CLI, if any. */
  cliConcurrency?: number;
  /** `--workflow` from the CLI, if any. */
  cliWorkflow?: string;
  /** `--exclude-trigger` from the CLI, if any. */
  cliExcludeTriggers?: string[];
  /** `--matrix-from-artifact` from the CLI, if any. */
  cliMatrixFromArtifact?: string;
  /** `--exclude-artifact` from the CLI, if any. */
  cliExcludeArtifacts?: string[];
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
    workflow: optionalString(data.workflow, `${source} workflow`),
    excludeTriggers: optionalStringArray(data.excludeTriggers, `${source} excludeTriggers`),
    matrixFromArtifact: optionalPattern(data.matrixFromArtifact, `${source} matrixFromArtifact`),
    excludeArtifacts: optionalStringArray(data.excludeArtifacts, `${source} excludeArtifacts`),
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
    workflow: optionalString(entry.workflow, `${where} workflow`),
    excludeTriggers: optionalStringArray(entry.excludeTriggers, `${where} excludeTriggers`),
    matrixFromArtifact: optionalPattern(entry.matrixFromArtifact, `${where} matrixFromArtifact`),
    excludeArtifacts: optionalStringArray(entry.excludeArtifacts, `${where} excludeArtifacts`),
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
  const {
    cliRepos,
    cliHoursBack,
    cliConcurrency,
    cliWorkflow,
    cliExcludeTriggers,
    cliMatrixFromArtifact,
    cliExcludeArtifacts,
    config,
    defaultConcurrency,
  } = input;
  const targets: CollectTarget[] = [];
  const seen = new Set<string>();

  const add = (repo: string, perRepo: Omit<RepoConfigEntry, "repo">) => {
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
      workflow: perRepo.workflow ?? cliWorkflow ?? config?.workflow,
      excludeTriggers: perRepo.excludeTriggers ?? cliExcludeTriggers ?? config?.excludeTriggers,
      matrixFromArtifact:
        perRepo.matrixFromArtifact ?? cliMatrixFromArtifact ?? config?.matrixFromArtifact,
      excludeArtifacts: perRepo.excludeArtifacts ?? cliExcludeArtifacts ?? config?.excludeArtifacts,
    });
  };

  for (const entry of config?.repos ?? []) {
    if (typeof entry === "string") {
      add(entry, {});
    } else {
      const { repo, ...perRepo } = entry;
      add(repo, perRepo);
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

export function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${where}: expected a non-empty string.`);
  }
  return value.trim();
}

/**
 * Validates a matrix pattern at config-parse time by compiling it, so a bad regex fails
 * immediately with the offending key named — rather than at the first artifact, mid-collect,
 * after the network work is already done.
 */
export function optionalPattern(value: unknown, where: string): string | undefined {
  if (optionalString(value, where) === undefined) {
    return undefined;
  }
  const pattern = value as string;
  compileMatrixPattern(pattern, where);
  return pattern;
}

function optionalStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`Invalid ${where}: expected an array of non-empty strings.`);
  }
  return (value as string[]).map((item) => item.trim());
}
