import { describe, expect, it } from "vitest";
import {
  detectFramework,
  diagnose,
  hasJavaBuildFile,
  packageJsonPaths,
} from "../src/doctor/diagnose.js";

function pkg(deps: Record<string, string>): string {
  return JSON.stringify({ devDependencies: deps });
}

describe("detectFramework", () => {
  it("identifies JS frameworks from package.json, most-specific first", () => {
    expect(
      detectFramework({ artifactNames: [], packageJsons: [pkg({ "@playwright/test": "1" })] }),
    ).toBe("playwright");
    // Cypress projects often also depend on mocha; Cypress must win.
    expect(
      detectFramework({ artifactNames: [], packageJsons: [pkg({ cypress: "13", mocha: "10" })] }),
    ).toBe("cypress");
    expect(detectFramework({ artifactNames: [], packageJsons: [pkg({ vitest: "2" })] })).toBe(
      "vitest",
    );
    expect(detectFramework({ artifactNames: [], packageJsons: [pkg({ jest: "29" })] })).toBe(
      "jest",
    );
  });

  it("unions dependencies across monorepo manifests", () => {
    // The root manifest has no framework; the subpackage's Cypress must still be found,
    // and an unparseable manifest along the way must not mask it.
    const framework = detectFramework({
      artifactNames: [],
      packageJsons: [pkg({ typescript: "5" }), "{ not json", pkg({ cypress: "13" })],
    });
    expect(framework).toBe("cypress");
  });

  it("falls back to Java for a build file, else unknown", () => {
    expect(detectFramework({ artifactNames: [], hasJavaBuild: true })).toBe("java");
    expect(detectFramework({ artifactNames: [] })).toBe("unknown");
    expect(detectFramework({ artifactNames: [], packageJsons: ["{ not json"] })).toBe("unknown");
  });
});

describe("packageJsonPaths", () => {
  it("keeps the root and shallow subpackages, shallowest first", () => {
    const paths = packageJsonPaths([
      "apps/web/package.json",
      "package.json",
      "src/index.ts",
      "packages/api/package.json",
    ]);
    expect(paths).toEqual(["package.json", "apps/web/package.json", "packages/api/package.json"]);
  });

  it("excludes node_modules and over-deep manifests, and caps the count", () => {
    const paths = packageJsonPaths([
      "node_modules/left-pad/package.json",
      "apps/web/deep/nested/package.json",
      ...["a", "b", "c", "d", "e", "f"].map((name) => `packages/${name}/package.json`),
    ]);
    expect(paths).toHaveLength(5);
    expect(paths.every((p) => p.startsWith("packages/"))).toBe(true);
  });
});

describe("hasJavaBuildFile", () => {
  it("finds build files at any depth, but never inside node_modules", () => {
    expect(hasJavaBuildFile(["services/billing/pom.xml"])).toBe(true);
    expect(hasJavaBuildFile(["build.gradle.kts"])).toBe(true);
    expect(hasJavaBuildFile(["node_modules/x/pom.xml", "src/main.ts"])).toBe(false);
  });
});

describe("diagnose", () => {
  it("reports success when a report-looking artifact is uploaded", () => {
    const result = diagnose({
      artifactNames: ["build-logs", "blob-report-chromium"],
      packageJsons: [pkg({ "@playwright/test": "1" })],
    });
    expect(result.uploadsReports).toBe(true);
    expect(result.matchedArtifacts).toEqual(["blob-report-chromium"]);
    expect(result.fix).toBeUndefined();
  });

  it("returns a framework-specific fix when no reports are uploaded", () => {
    const result = diagnose({
      artifactNames: ["screenshots", "videos"],
      packageJsons: [pkg({ cypress: "13" })],
    });
    expect(result.uploadsReports).toBe(false);
    expect(result.framework).toBe("cypress");
    expect(result.fix?.yaml).toContain("upload-artifact");
    expect(result.fix?.yaml).toContain("mochawesome-report");
    expect(result.fix?.steps.join(" ")).toContain("cypress-mochawesome-reporter");
  });

  it("gives a generic JUnit fix for an unknown framework", () => {
    const result = diagnose({ artifactNames: [] });
    expect(result.framework).toBe("unknown");
    expect(result.fix?.yaml).toContain("junit");
  });
});
