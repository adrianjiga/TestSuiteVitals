import { defineCommand } from "citty";
import { colorSupported, createPalette, type Palette, terminalSafe } from "../colors.js";
import {
  type Diagnosis,
  diagnose,
  hasJavaBuildFile,
  JAVA_BUILD_FILES,
  packageJsonPaths,
  type RepoSignals,
  retryConfigPaths,
} from "../doctor/diagnose.js";
import { listRunArtifacts } from "../github/artifacts.js";
import { AuthError } from "../github/auth.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import { getRepoFile, listRepoTree, repoHasFile } from "../github/contents.js";
import { parseRepoRef, type RepoRef, repoSlug } from "../github/repo.js";
import { listRecentCompletedRuns } from "../github/runs.js";

/** How many recent completed runs to inspect for uploaded artifacts. */
const RUNS_TO_INSPECT = 10;
/** How far back to look for runs. */
const LOOKBACK_DAYS = 30;

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Check whether a repo uploads parseable test reports, and how to fix it if not",
  },
  args: {
    repo: {
      type: "string",
      description: "Repository to inspect, as owner/name",
      required: true,
    },
    token: {
      type: "string",
      description: "GitHub token (overrides GITHUB_TOKEN and the gh CLI)",
    },
  },
  async run({ args }) {
    const palette = createPalette(colorSupported);
    const ref = parseRepoRef(args.repo);
    const slug = repoSlug(ref);

    const client = await authenticate(args.token, palette);
    if (!client) {
      return;
    }

    console.log(`Inspecting ${palette.repo(slug)}…`);
    const signals = await gatherSignals(client, ref);
    const result = diagnose(signals);
    printDiagnosis(slug, signals, result, palette);
  },
});

/** Reads the recent runs' artifact names and the repo's manifests into {@link RepoSignals}. */
async function gatherSignals(client: GitHubClient, ref: RepoRef): Promise<RepoSignals> {
  const { octokit } = client;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const completed = await listRecentCompletedRuns(octokit, ref, since, RUNS_TO_INSPECT);

  const artifactNames = new Set<string>();
  for (const run of completed) {
    for (const artifact of await listRunArtifacts(octokit, ref, run.run_id)) {
      artifactNames.add(artifact.name);
    }
  }

  // One tree listing sees monorepo manifests (`apps/web/package.json`) and Java build files
  // anywhere; when it is unavailable (huge/empty repo), fall back to root-only probing.
  const tree = await listRepoTree(octokit, ref);
  if (tree) {
    const manifests = await Promise.all(
      packageJsonPaths(tree).map((path) => getRepoFile(octokit, ref, path)),
    );
    const configs = await Promise.all(
      retryConfigPaths(tree).map(async (path) => ({
        path,
        content: await getRepoFile(octokit, ref, path),
      })),
    );
    return {
      artifactNames: [...artifactNames],
      packageJsons: manifests.filter((content): content is string => content !== null),
      hasJavaBuild: hasJavaBuildFile(tree),
      configFiles: configs.filter(
        (file): file is { path: string; content: string } => file.content !== null,
      ),
    };
  }

  const rootManifest = await getRepoFile(octokit, ref, "package.json");
  return {
    artifactNames: [...artifactNames],
    packageJsons: rootManifest === null ? [] : [rootManifest],
    hasJavaBuild: await repoHasFile(octokit, ref, JAVA_BUILD_FILES),
  };
}

function printDiagnosis(slug: string, signals: RepoSignals, result: Diagnosis, p: Palette): void {
  console.log(
    `  Framework: ${result.framework === "unknown" ? p.dim("unknown") : result.framework}`,
  );
  console.log(`  Artifacts seen: ${signals.artifactNames.length || p.dim("none")}`);

  if (result.uploadsReports) {
    console.log(
      p.good(
        `\n✓ ${slug} uploads parseable reports: ${terminalSafe(result.matchedArtifacts.join(", "))}.`,
      ),
    );
    console.log(`  Run \`suitevitals collect --repo ${slug}\` to start collecting.`);
  } else {
    console.log(p.warn(`\n⚠ ${slug} uploads no parseable test reports.`));
    const fix = result.fix;
    if (fix) {
      console.log(`\n  ${p.heading(fix.summary)}`);
      for (const step of fix.steps) {
        console.log(`  ${p.dim(step)}`);
      }
      console.log("");
      for (const line of fix.yaml.split("\n")) {
        console.log(`    ${p.dim(line)}`);
      }
    }
  }

  const retries = result.retries;
  if (retries) {
    const summary =
      retries.kind === "warn" ? p.warn(`⚠ ${retries.summary}`) : p.heading(retries.summary);
    console.log(`\n  ${summary}`);
    for (const step of retries.steps) {
      console.log(`  ${p.dim(step)}`);
    }
  }
}

/** Resolves the client; on auth failure reports it, sets exit code, returns null. */
async function authenticate(
  token: string | undefined,
  palette: Palette,
): Promise<GitHubClient | null> {
  try {
    const client = await createGitHubClient({ token });
    console.log(palette.dim(`Authenticated with GitHub (token source: ${client.tokenSource}).`));
    return client;
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(palette.bad(error.message));
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}
