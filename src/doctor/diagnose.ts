import { matchesReportArtifact } from "../github/artifacts.js";

/** Test frameworks doctor can recognize and advise on. */
export type Framework = "playwright" | "cypress" | "vitest" | "jest" | "mocha" | "java" | "unknown";

/** What doctor observed about a repo, gathered from the GitHub API (pure input here). */
export interface RepoSignals {
  /** Artifact names seen across the inspected runs. */
  artifactNames: string[];
  /** Raw `package.json` contents, if the repo has one. */
  packageJson?: string;
  /** A Maven/Gradle build file is present (Java → JUnit-format reports). */
  hasJavaBuild?: boolean;
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
}

/**
 * Detects the test framework from a repo's manifests. JS frameworks come from `package.json`
 * dependencies (most specific first: Playwright/Cypress before the generic runners); a Java
 * build file maps to JUnit-format Surefire/TestNG output.
 */
export function detectFramework(signals: RepoSignals): Framework {
  const deps = parseDeps(signals.packageJson);
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

  if (uploadsReports) {
    return { framework, uploadsReports, matchedArtifacts };
  }
  return { framework, uploadsReports, matchedArtifacts, fix: FIXES[framework] };
}

/** Reads the union of dependencies + devDependencies from a `package.json`, or null if unusable. */
function parseDeps(packageJson: string | undefined): Set<string> | null {
  if (!packageJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ]);
  } catch {
    return null;
  }
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
