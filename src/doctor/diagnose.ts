import { matchesReportArtifact } from "../github/artifacts.js";

/** Test frameworks doctor can recognize and advise on. */
export type Framework = "playwright" | "cypress" | "vitest" | "jest" | "mocha" | "java" | "unknown";

/** Java build files that imply JUnit-format reports. */
export const JAVA_BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts"];

/** How many package.json manifests to read; root first, then the shallowest subdirectories. */
const MANIFEST_LIMIT = 5;

/** Deepest manifest considered, in path segments — `apps/web/package.json` yes, deeper no. */
const MANIFEST_MAX_DEPTH = 3;

/** How many runner configs, `pom.xml` files and workflows to read for retry settings. */
const RETRY_CONFIG_LIMIT = 8;

const RETRY_CONFIG_FILE = /^(?:playwright|cypress)\.config\.[cm]?[jt]s$|^pom\.xml$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** What doctor observed about a repo, gathered from the GitHub API (pure input here). */
export interface RepoSignals {
  /** Artifact names seen across the inspected runs. */
  artifactNames: string[];
  /** Raw `package.json` contents — the root one plus monorepo subpackages, when found. */
  packageJsons?: string[];
  /** A Maven/Gradle build file is present (Java → JUnit-format reports). */
  hasJavaBuild?: boolean;
  /** Runner configs, `pom.xml` files and workflows, read to check retry settings. */
  configFiles?: { path: string; content: string }[];
}

/**
 * The `package.json` paths worth reading from a full tree listing: the root manifest and
 * shallow monorepo packages (depth ≤ {@link MANIFEST_MAX_DEPTH}), never `node_modules`,
 * shallowest first, capped at {@link MANIFEST_LIMIT} so a huge workspace stays cheap.
 */
export function packageJsonPaths(paths: string[]): string[] {
  return paths
    .filter(
      (path) =>
        (path === "package.json" || path.endsWith("/package.json")) &&
        !path.includes("node_modules/") &&
        path.split("/").length <= MANIFEST_MAX_DEPTH,
    )
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))
    .slice(0, MANIFEST_LIMIT);
}

/** True when a Java build file exists anywhere in the tree outside `node_modules`. */
export function hasJavaBuildFile(paths: string[]): boolean {
  return paths.some(
    (path) =>
      JAVA_BUILD_FILES.includes(path.split("/").at(-1) ?? "") && !path.includes("node_modules/"),
  );
}

/**
 * The files whose contents reveal retry settings: Playwright/Cypress configs, `pom.xml` and
 * workflow YAML (where `--retries` or `-Dsurefire.rerunFailingTestsCount` often live), never
 * `node_modules`, shallowest first, capped at {@link RETRY_CONFIG_LIMIT}.
 */
export function retryConfigPaths(paths: string[]): string[] {
  return paths
    .filter(
      (path) =>
        !path.includes("node_modules/") &&
        path.split("/").length <= MANIFEST_MAX_DEPTH &&
        (RETRY_CONFIG_FILE.test(path.split("/").at(-1) ?? "") || WORKFLOW_FILE.test(path)),
    )
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))
    .slice(0, RETRY_CONFIG_LIMIT);
}

/**
 * Retry advice for the detected framework. `suggest`: retries are off, and turning them on adds
 * pass-after-retry, the strongest flake signal. `warn`: retries are on but the stored report
 * keeps only the final attempt, so failures a retry rescued never reach the flake score.
 */
export interface RetryAdvice {
  kind: "suggest" | "warn";
  summary: string;
  steps: string[];
}

/**
 * Advises on retries only where the advice is safe: Playwright (the blob report records every
 * retry), Maven Surefire with JUnit (`rerunFailingTestsCount` writes `flakyFailure`), and a
 * warning for Cypress (the Mochawesome adapter reads one attempt per test). TestNG, Gradle and unreadable configs
 * get none. Pure over {@link RepoSignals}.
 */
export function adviseRetries(framework: Framework, signals: RepoSignals): RetryAdvice | undefined {
  const files = signals.configFiles ?? [];
  const named = (pattern: RegExp) =>
    files.filter((file) => pattern.test(file.path.split("/").at(-1) ?? ""));
  const workflows = files.filter((file) => WORKFLOW_FILE.test(file.path));

  if (framework === "playwright") {
    const configs = named(/^playwright\.config\./);
    if (configs.length === 0) {
      return undefined;
    }
    const inConfig = configs.some((file) =>
      [...file.content.matchAll(/\bretries\s*:\s*([^,\n}]+)/g)].some(
        (match) => match[1]?.trim() !== "0",
      ),
    );
    const inWorkflow = workflows.some((file) => /--retries[= ]+[1-9]/.test(file.content));
    if (inConfig || inWorkflow) {
      return undefined;
    }
    return {
      kind: "suggest",
      summary: "Turn on Playwright retries: a pass after a retry is the strongest flake signal.",
      steps: ["In playwright.config.ts:", "  retries: process.env.CI ? 2 : 0,"],
    };
  }

  if (framework === "java") {
    const poms = named(/^pom\.xml$/);
    if (poms.length === 0 || poms.some((file) => /testng/i.test(file.content))) {
      return undefined;
    }
    if ([...poms, ...workflows].some((file) => file.content.includes("rerunFailingTestsCount"))) {
      return undefined;
    }
    return {
      kind: "suggest",
      summary: "Turn on Surefire reruns: a pass after a rerun is the strongest flake signal.",
      steps: [
        "In the maven-surefire-plugin <configuration> of pom.xml:",
        "  <rerunFailingTestsCount>2</rerunFailingTestsCount>",
        "or run: mvn test -Dsurefire.rerunFailingTestsCount=2",
      ],
    };
  }

  if (framework === "cypress") {
    const retriesOn = named(/^cypress\.config\./).some((file) =>
      /\bretries\s*:\s*[1-9]|\brunMode\s*:\s*[1-9]/.test(file.content),
    );
    if (!retriesOn) {
      return undefined;
    }
    return {
      kind: "warn",
      summary:
        "Cypress retries are on, but suitevitals reads only the final attempt from Mochawesome.",
      steps: [
        "A failure that a retry rescued is stored as a plain pass, so the flake score",
        "never sees it; flip rate across runs still catches tests that fail often.",
      ],
    };
  }

  return undefined;
}

/** A concrete, copy-pasteable fix for a framework that uploads no parseable reports. */
export interface FrameworkFix {
  /** One-line description of the reporter to enable. */
  summary: string;
  /** Setup steps (install, config) preceding the workflow change. */
  steps: string[];
  /** The `upload-artifact` (and reporter) YAML to add to the workflow. */
  yaml: string;
}

export interface Diagnosis {
  framework: Framework;
  /** True if at least one report-looking artifact is already uploaded. */
  uploadsReports: boolean;
  /** The artifact names that matched the report patterns. */
  matchedArtifacts: string[];
  /** The fix to apply when no reports are uploaded; absent when {@link uploadsReports}. */
  fix?: FrameworkFix;
  /** Retry advice, independent of whether reports are uploaded. */
  retries?: RetryAdvice;
}

/**
 * Detects the test framework from a repo's manifests. JS frameworks come from `package.json`
 * dependencies — unioned across every manifest so a monorepo's subpackage counts — most
 * specific first (Playwright/Cypress before the generic runners); a Java build file maps to
 * JUnit-format Surefire/TestNG output.
 */
export function detectFramework(signals: RepoSignals): Framework {
  const deps = parseDeps(signals.packageJsons);
  if (deps) {
    if (deps.has("@playwright/test")) {
      return "playwright";
    }
    if (deps.has("cypress")) {
      return "cypress";
    }
    if (deps.has("vitest")) {
      return "vitest";
    }
    if (deps.has("jest")) {
      return "jest";
    }
    if (deps.has("mocha")) {
      return "mocha";
    }
  }
  if (signals.hasJavaBuild) {
    return "java";
  }
  return "unknown";
}

/**
 * Diagnoses whether suitevitals can collect from a repo: are report artifacts uploaded, and if
 * not, what is the exact fix for the detected framework? Pure over {@link RepoSignals}.
 */
export function diagnose(signals: RepoSignals): Diagnosis {
  const matchedArtifacts = signals.artifactNames.filter(matchesReportArtifact);
  const framework = detectFramework(signals);
  const uploadsReports = matchedArtifacts.length > 0;
  const retries = adviseRetries(framework, signals);

  return {
    framework,
    uploadsReports,
    matchedArtifacts,
    ...(uploadsReports ? {} : { fix: FIXES[framework] }),
    ...(retries ? { retries } : {}),
  };
}

/**
 * Unions dependencies + devDependencies across every readable `package.json`, or null when
 * none is usable. An unparseable manifest is skipped, not fatal — the others still count.
 */
function parseDeps(packageJsons: string[] | undefined): Set<string> | null {
  if (!packageJsons || packageJsons.length === 0) {
    return null;
  }
  const deps = new Set<string>();
  let readable = false;
  for (const packageJson of packageJsons) {
    try {
      const parsed = JSON.parse(packageJson) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      readable = true;
      for (const name of Object.keys(parsed.dependencies ?? {})) {
        deps.add(name);
      }
      for (const name of Object.keys(parsed.devDependencies ?? {})) {
        deps.add(name);
      }
    } catch {
      // Skip this manifest; the others may still identify the framework.
    }
  }
  return readable ? deps : null;
}

const UPLOAD_NOTE = "# pin actions/upload-artifact to a SHA in real workflows";

const FIXES: Record<Framework, FrameworkFix> = {
  playwright: {
    summary: "Enable Playwright's blob reporter and upload blob-report/.",
    steps: [
      "Add the blob reporter in playwright.config.ts:",
      "  reporter: process.env.CI ? 'blob' : 'list',",
    ],
    yaml: `# after your "npx playwright test" step (even on failure):
- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: playwright-report
    path: blob-report/`,
  },
  cypress: {
    summary: "Add the mochawesome reporter and upload its JSON.",
    steps: [
      "npm i -D cypress-mochawesome-reporter",
      "In cypress.config.js: reporter: 'cypress-mochawesome-reporter'",
    ],
    yaml: `# after your "cypress run" step (even on failure):
- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: mochawesome-report
    path: cypress/reports/`,
  },
  vitest: {
    summary: "Enable Vitest's built-in JUnit reporter and upload the XML.",
    steps: ["Run: vitest run --reporter=junit --outputFile=junit.xml"],
    yaml: `- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: junit-results
    path: junit.xml`,
  },
  jest: {
    summary: "Add jest-junit and upload the XML.",
    steps: ["npm i -D jest-junit", "Run jest with: --reporters=default --reporters=jest-junit"],
    yaml: `- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: junit-results
    path: junit.xml`,
  },
  mocha: {
    summary: "Add mocha-junit-reporter and upload the XML.",
    steps: ["npm i -D mocha-junit-reporter", "Run mocha with: --reporter mocha-junit-reporter"],
    yaml: `- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: junit-results
    path: test-results.xml`,
  },
  java: {
    summary: "Surefire/Failsafe already write JUnit XML — just upload it.",
    steps: ["No reporter change needed; Surefire writes target/surefire-reports/*.xml."],
    yaml: `- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: junit-results
    path: '**/target/surefire-reports/*.xml'`,
  },
  unknown: {
    summary: "Make your test runner emit JUnit XML, then upload it.",
    steps: [
      "Most runners have a JUnit reporter (jest-junit, mocha-junit-reporter,",
      "vitest --reporter=junit, pytest --junitxml, etc.). Enable one, then:",
    ],
    yaml: `- uses: actions/upload-artifact@v4  ${UPLOAD_NOTE}
  if: always()
  with:
    name: junit-results
    path: '**/junit*.xml'`,
  },
};
