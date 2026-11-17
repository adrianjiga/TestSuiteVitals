import { describe, expect, it } from "vitest";
import { compileMatrixPattern, matrixForArtifact } from "../src/collect/matrix.js";

const CYPRESS = "cypress-results-(?<group>[^-]+)-(?<browser>[^-]+)-(?<viewport>[^-]+)";

describe("compileMatrixPattern", () => {
  it("compiles a pattern with named groups", () => {
    expect(compileMatrixPattern(CYPRESS)).toBeInstanceOf(RegExp);
  });

  it("rejects a pattern whose named group is escaped or inside a character class", () => {
    expect(() => compileMatrixPattern("results-\\(?<browser>")).toThrow(/named group/);
    expect(() => compileMatrixPattern("[(?<x>)]")).toThrow(/named group/);
  });

  it("rejects a pattern with no named groups", () => {
    // Group names *are* the matrix dimensions, so a pattern without them cannot produce a
    // cell — far more likely a mistake than an intent.
    expect(() => compileMatrixPattern("cypress-results-(.+)")).toThrow(/named group/);
  });

  it("rejects an invalid regular expression", () => {
    expect(() => compileMatrixPattern("(?<b>[a-z")).toThrow(/not a valid regular expression/);
  });

  it("names the offending key so a config typo is locatable", () => {
    expect(() => compileMatrixPattern("nope", "config repos[2] matrixFromArtifact")).toThrow(
      /config repos\[2\] matrixFromArtifact/,
    );
  });
});

describe("matrixForArtifact", () => {
  it("reads named groups out of the artifact name", () => {
    const cell = matrixForArtifact(
      "cypress-results-webtables-firefox-desktop",
      compileMatrixPattern(CYPRESS),
    );
    expect(cell).toEqual({ group: "webtables", browser: "firefox", viewport: "desktop" });
  });

  it("distinguishes two cells that differ only by browser", () => {
    const pattern = compileMatrixPattern(CYPRESS);
    const chrome = matrixForArtifact("cypress-results-ui-chrome-desktop", pattern);
    const firefox = matrixForArtifact("cypress-results-ui-firefox-desktop", pattern);
    expect(chrome).not.toEqual(firefox);
  });

  it("falls back to the opaque form when the name does not match", () => {
    // A report is evidence. Dropping it because a pattern was mistyped is precisely the
    // silent-loss failure this module exists to prevent.
    const cell = matrixForArtifact("final-test-report", compileMatrixPattern(CYPRESS));
    expect(cell).toEqual({ artifact: "final-test-report" });
  });

  it("falls back to the opaque form when no pattern is configured", () => {
    expect(matrixForArtifact("test-reports-ui")).toEqual({ artifact: "test-reports-ui" });
  });

  it("omits optional groups that did not participate in the match", () => {
    // Otherwise two artifacts differing only by an absent optional group would land in
    // different cells purely because one carries an undefined key.
    const pattern = compileMatrixPattern("run-(?<browser>[a-z]+)(?:-(?<viewport>[a-z]+))?");
    expect(matrixForArtifact("run-chrome", pattern)).toEqual({ browser: "chrome" });
    expect(matrixForArtifact("run-chrome-mobile", pattern)).toEqual({
      browser: "chrome",
      viewport: "mobile",
    });
  });
});
