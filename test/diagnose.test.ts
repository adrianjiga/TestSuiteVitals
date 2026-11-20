import { describe, expect, it } from "vitest";
import {
  adviseRetries,
  detectFramework,
  diagnose,
  hasJavaBuildFile,
  packageJsonPaths,
  type RepoSignals,
  retryConfigPaths,
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

describe("retryConfigPaths", () => {
  it("picks runner configs and pom.xml files, then workflows, shallowest first", () => {
    const tree = [
      "apps/e2e/playwright.config.ts",
      "playwright.config.ts",
      "cypress.config.js",
      "pom.xml",
      "module/pom.xml",
      ".github/workflows/ci.yml",
      ".github/workflows/nightly.yaml",
      "node_modules/x/playwright.config.ts",
      "src/app.ts",
      "docs/pom.xml.md",
    ];
    expect(retryConfigPaths(tree)).toEqual([
      "cypress.config.js",
      "playwright.config.ts",
      "pom.xml",
      "module/pom.xml",
      "apps/e2e/playwright.config.ts",
      ".github/workflows/ci.yml",
      ".github/workflows/nightly.yaml",
    ]);
  });

  it("caps configs and workflows separately, so many workflows never crowd out a config", () => {
    const workflows = Array.from({ length: 20 }, (_, i) => `.github/workflows/w${i}.yml`);
    const picked = retryConfigPaths([...workflows, "apps/e2e/playwright.config.ts"]);
    expect(picked).toContain("apps/e2e/playwright.config.ts");
    expect(picked.filter((path) => path.startsWith(".github/"))).toHaveLength(4);
    const poms = Array.from({ length: 20 }, (_, i) => `m${i}/pom.xml`);
    expect(retryConfigPaths(poms)).toHaveLength(6);
  });
});

describe("adviseRetries", () => {
  function signals(files: Record<string, string>): RepoSignals {
    return {
      artifactNames: [],
      configFiles: Object.entries(files).map(([path, content]) => ({ path, content })),
    };
  }

  it("suggests Playwright retries when the config sets none", () => {
    const advice = adviseRetries(
      "playwright",
      signals({ "playwright.config.ts": "export default { reporter: 'blob', retries: 0 };" }),
    );
    expect(advice?.kind).toBe("suggest");
    expect(advice?.steps.join("\n")).toMatch(/retries: process\.env\.CI \? 2 : 0/);
  });

  it("stays quiet for a Playwright config without the blob reporter, which drops retries", () => {
    expect(
      adviseRetries(
        "playwright",
        signals({ "playwright.config.ts": "reporter: [['junit', { outputFile: 'junit.xml' }]]," }),
      ),
    ).toBeUndefined();
    expect(
      adviseRetries(
        "playwright",
        signals({ "playwright.config.ts": "reporter: process.env.CI ? 'blob' : 'list'," }),
      )?.kind,
    ).toBe("suggest");
  });

  it("stays quiet when Playwright retries are on in the config or the workflow", () => {
    expect(
      adviseRetries(
        "playwright",
        signals({ "playwright.config.ts": "reporter: 'blob', retries: process.env.CI ? 2 : 0," }),
      ),
    ).toBeUndefined();
    expect(
      adviseRetries(
        "playwright",
        signals({
          "playwright.config.ts": "export default { reporter: 'blob' };",
          ".github/workflows/ci.yml": "run: npx playwright test --retries=2",
        }),
      ),
    ).toBeUndefined();
  });

  it("suggests Surefire reruns for Maven with JUnit, unless already set", () => {
    const pom = "<dependency><artifactId>junit-jupiter</artifactId></dependency>";
    expect(adviseRetries("java", signals({ "pom.xml": pom }))?.steps.join("\n")).toMatch(
      /rerunFailingTestsCount/,
    );
    expect(
      adviseRetries(
        "java",
        signals({ "pom.xml": `${pom}<rerunFailingTestsCount>2</rerunFailingTestsCount>` }),
      ),
    ).toBeUndefined();
    expect(
      adviseRetries(
        "java",
        signals({
          "pom.xml": pom,
          ".github/workflows/ci.yml": "run: mvn test -Dsurefire.rerunFailingTestsCount=2",
        }),
      ),
    ).toBeUndefined();
  });

  it("gives no Java advice for TestNG or a Gradle-only build", () => {
    const testng = "<dependency><artifactId>testng</artifactId></dependency>";
    expect(adviseRetries("java", signals({ "pom.xml": testng }))).toBeUndefined();
    expect(adviseRetries("java", signals({ ".github/workflows/ci.yml": "gradle test" }))).toBe(
      undefined,
    );
  });

  it("warns that Cypress retries hide failures from the flake score", () => {
    for (const config of [
      "retries: 2,",
      "retries: { runMode: 2, openMode: 0 },",
      "retries: process.env.CI ? 2 : 0,",
      "retries: { runMode: Number(process.env.RETRIES), openMode: 0 },",
    ]) {
      const advice = adviseRetries("cypress", signals({ "cypress.config.js": config }));
      expect(advice?.kind).toBe("warn");
    }
    for (const config of ["retries: 0,", "retries: { runMode: 0, openMode: 2 },"]) {
      expect(adviseRetries("cypress", signals({ "cypress.config.js": config }))).toBeUndefined();
    }
  });

  it("gives no advice without readable config files or for other frameworks", () => {
    expect(adviseRetries("playwright", { artifactNames: [] })).toBeUndefined();
    expect(adviseRetries("jest", signals({ "jest.config.js": "" }))).toBeUndefined();
  });

  it("is attached to the diagnosis whether or not reports are uploaded", () => {
    const base = signals({ "playwright.config.ts": "export default { reporter: 'blob' };" });
    const pw = [JSON.stringify({ devDependencies: { "@playwright/test": "1" } })];
    expect(
      diagnose({ ...base, packageJsons: pw, artifactNames: ["playwright-report"] }).retries?.kind,
    ).toBe("suggest");
    expect(diagnose({ ...base, packageJsons: pw }).retries?.kind).toBe("suggest");
  });
});
