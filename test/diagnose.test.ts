import { describe, expect, it } from "vitest";
import { detectFramework, diagnose } from "../src/doctor/diagnose.js";

function pkg(deps: Record<string, string>): string {
  return JSON.stringify({ devDependencies: deps });
}

describe("detectFramework", () => {
  it("identifies JS frameworks from package.json, most-specific first", () => {
    expect(
      detectFramework({ artifactNames: [], packageJson: pkg({ "@playwright/test": "1" }) }),
    ).toBe("playwright");
    // Cypress projects often also depend on mocha; Cypress must win.
    expect(
      detectFramework({ artifactNames: [], packageJson: pkg({ cypress: "13", mocha: "10" }) }),
    ).toBe("cypress");
    expect(detectFramework({ artifactNames: [], packageJson: pkg({ vitest: "2" }) })).toBe(
      "vitest",
    );
    expect(detectFramework({ artifactNames: [], packageJson: pkg({ jest: "29" }) })).toBe("jest");
  });

  it("falls back to Java for a build file, else unknown", () => {
    expect(detectFramework({ artifactNames: [], hasJavaBuild: true })).toBe("java");
    expect(detectFramework({ artifactNames: [] })).toBe("unknown");
    expect(detectFramework({ artifactNames: [], packageJson: "{ not json" })).toBe("unknown");
  });
});

describe("diagnose", () => {
  it("reports success when a report-looking artifact is uploaded", () => {
    const result = diagnose({
      artifactNames: ["build-logs", "blob-report-chromium"],
      packageJson: pkg({ "@playwright/test": "1" }),
    });
    expect(result.uploadsReports).toBe(true);
    expect(result.matchedArtifacts).toEqual(["blob-report-chromium"]);
    expect(result.fix).toBeUndefined();
  });

  it("returns a framework-specific fix when no reports are uploaded", () => {
    const result = diagnose({
      artifactNames: ["screenshots", "videos"],
      packageJson: pkg({ cypress: "13" }),
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
