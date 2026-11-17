import { describe, expect, it } from "vitest";
import { computeWindow, DEFAULT_BACKFILL_HOURS } from "../src/collect/window.js";

const NOW = new Date("2026-06-23T12:00:00Z");

describe("computeWindow", () => {
  it("uses the watermark when present and no override is given", () => {
    const result = computeWindow(
      { pending_runs: [], watermark: "2026-06-20T00:00:00Z" },
      { now: NOW },
    );
    expect(result).toEqual({ since: new Date("2026-06-20T00:00:00Z"), source: "watermark" });
  });

  it("falls back to the default backfill on first run (no watermark)", () => {
    const result = computeWindow({ pending_runs: [] }, { now: NOW });
    expect(result.source).toBe("default");
    const expectedMs = NOW.getTime() - DEFAULT_BACKFILL_HOURS * 3600_000;
    expect(result.since.getTime()).toBe(expectedMs);
  });

  it("lets --hours-back widen the window past the watermark", () => {
    const result = computeWindow(
      { pending_runs: [], watermark: "2026-06-22T00:00:00Z" },
      { hoursBack: 72, now: NOW },
    );
    expect(result).toEqual({ since: new Date("2026-06-20T12:00:00Z"), source: "hours-back" });
  });

  it("never lets --hours-back narrow the window past an older watermark", () => {
    const result = computeWindow(
      { pending_runs: [], watermark: "2026-06-20T00:00:00Z" },
      { hoursBack: 24, now: NOW },
    );
    expect(result).toEqual({ since: new Date("2026-06-20T00:00:00Z"), source: "watermark" });
  });

  it("uses --hours-back alone when there is no watermark", () => {
    const result = computeWindow({ pending_runs: [] }, { hoursBack: 24, now: NOW });
    expect(result).toEqual({ since: new Date("2026-06-22T12:00:00Z"), source: "hours-back" });
  });
});
