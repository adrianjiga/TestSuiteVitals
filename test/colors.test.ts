import { describe, expect, it } from "vitest";
import { createPalette, plainPalette, terminalSafe } from "../src/colors.js";

describe("createPalette", () => {
  it("is a no-op when disabled", () => {
    const p = createPalette(false);
    expect(p.heading("x")).toBe("x");
    expect(p.score("50", 50)).toBe("50");
    expect(p.signal("0", false)).toBe("0");
    expect(plainPalette.bad("y")).toBe("y");
  });

  it("wraps text in ANSI codes when enabled", () => {
    expect(createPalette(true).good("ok")).toContain("[");
  });

  it("colors a score by severity threshold", () => {
    const p = createPalette(true);
    expect(p.score("x", 60)).toContain("[31m"); // red for high
    expect(p.score("x", 30)).toContain("[33m"); // yellow for mid
    expect(p.score("x", 5)).toContain("[2m"); // dim for low
  });
});

describe("terminalSafe", () => {
  it("replaces escape and other control characters, keeping whitespace as a space", () => {
    expect(terminalSafe("a\u001b]52;c;cHduZWQ=\u0007b\tc\nd\u009b")).toBe(
      "a\uFFFD]52;c;cHduZWQ=\uFFFDb c d\uFFFD",
    );
  });

  it("leaves ordinary text, including non-ASCII, untouched", () => {
    expect(terminalSafe("Login › logs in — ünïcødé ✓")).toBe("Login › logs in — ünïcødé ✓");
  });
});
