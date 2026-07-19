import { describe, expect, it } from "vitest";
import { looksLikeJUnit, parseJUnit } from "../src/adapters/junit.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Web Tables" file="tests/webTables.spec.ts">
    <testcase classname="tests/webTables.spec.ts" name="adds a record" time="1.5"/>
    <testcase classname="tests/webTables.spec.ts" name="deletes a record" time="2.0">
      <failure message="Timed out waiting for selector">at fn (/ci/app.ts:10:5)</failure>
    </testcase>
    <testcase classname="tests/webTables.spec.ts" name="skipped one" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

describe("looksLikeJUnit", () => {
  it("detects testsuites and testsuite roots", () => {
    expect(looksLikeJUnit(SAMPLE)).toBe(true);
    expect(looksLikeJUnit('<testsuite name="x"/>')).toBe(true);
  });

  it("accepts a BOM, comments, and a DOCTYPE before the root", () => {
    expect(looksLikeJUnit("\uFEFF<!-- generated -->\n<testsuites></testsuites>")).toBe(true);
    expect(
      looksLikeJUnit('<?xml version="1.0"?><!DOCTYPE testsuites [<!ENTITY x "a">]><testsuites/>'),
    ).toBe(true);
  });

  it("rejects non-JUnit content", () => {
    expect(looksLikeJUnit('{"stats":{}}')).toBe(false);
  });

  it("rejects a document that merely mentions the tag mid-content", () => {
    // A mochawesome JSON quoting XML in an error message must not be routed to the XML parser.
    const json = '{"stats":{"passPercent":1},"err":"expected <testsuite name=\\"x\\"> here"}';
    expect(looksLikeJUnit(json)).toBe(false);
  });
});

describe("parseJUnit", () => {
  it("parses passed, failed, and skipped testcases", () => {
    const tests = parseJUnit(SAMPLE);
    expect(tests.map((t) => t.status)).toEqual(["passed", "failed", "skipped"]);
  });

  it("maps time to milliseconds and derives file/title", () => {
    const [first] = parseJUnit(SAMPLE);
    expect(first?.file).toBe("tests/webTables.spec.ts");
    expect(first?.title_path).toEqual(["adds a record"]);
    expect(first?.duration_ms).toBe(1500);
    expect(first?.attempts).toHaveLength(1);
  });

  it("attaches a redacted, fingerprinted error to failures", () => {
    const failed = parseJUnit(SAMPLE)[1];
    expect(failed?.attempts[0]?.error?.message).toBe("Timed out waiting for selector");
    expect(failed?.attempts[0]?.error?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles a single <testsuite> root", () => {
    const xml = '<testsuite name="s"><testcase name="t" time="0.5"/></testsuite>';
    const tests = parseJUnit(xml);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.duration_ms).toBe(500);
  });

  it("still decodes built-in entities in ordinary documents", () => {
    const xml = '<testsuite name="s"><testcase name="a &amp; b" time="0"/></testsuite>';
    expect(parseJUnit(xml)[0]?.title_path).toEqual(["a & b"]);
  });

  it("does not expand DOCTYPE-declared entities (amplification guard)", () => {
    // One long entity referenced many times expands quadratically; a DOCTYPE-bearing
    // document must parse with entity processing off, leaving references literal.
    const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuites [<!ENTITY x "${"A".repeat(50)}">]>
<testsuites><testsuite name="s"><testcase name="&x;&x;&x;" time="0"/></testsuite></testsuites>`;
    const [test] = parseJUnit(xml);
    expect(test?.title_path).toEqual(["&x;&x;&x;"]);
  });
});
