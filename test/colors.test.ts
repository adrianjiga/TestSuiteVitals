import { describe, expect, it } from "vitest";
import { createPalette, plainPalette } from "../src/colors.js";

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
