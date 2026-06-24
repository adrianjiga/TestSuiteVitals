import { describe, expect, it } from "vitest";
import {
  fingerprint,
  makeTestError,
  redactError,
  redactSecrets,
  truncate,
} from "../src/events/error.js";

describe("redactSecrets", () => {
  it("redacts GitHub tokens", () => {
    expect(redactSecrets(`token ghp_${"a".repeat(36)} leaked`)).toBe("token [REDACTED] leaked");
  });

  it("redacts bearer headers and key=value secrets", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123")).toContain("Bearer [REDACTED]");
    expect(redactSecrets("password=hunter2")).toBe("password=[REDACTED]");
  });

  it("redacts query-string values but keeps the key", () => {
    expect(redactSecrets("GET /x?sig=deadbeef&n=1")).toBe("GET /x?sig=[REDACTED]&n=[REDACTED]");
  });
});

describe("truncate", () => {
  it("leaves short text untouched", () => {
    expect(truncate("short", 400)).toBe("short");
  });

  it("truncates long single-line text", () => {
    expect(truncate("x".repeat(500), 400)).toBe(`${"x".repeat(400)} …[truncated]`);
  });

  it("never cuts the first line even when it exceeds the limit", () => {
    const text = `${"a".repeat(50)}\nmore`;
    expect(truncate(text, 10)).toBe(`${"a".repeat(50)} …[truncated]`);
  });
});

describe("redactError", () => {
  it("redacts and truncates by default", () => {
    const msg = `password=hunter2 ${"x".repeat(500)}`;
    const result = redactError(msg);
    expect(result).toContain("[REDACTED]");
    expect(result.endsWith("…[truncated]")).toBe(true);
  });

  it("bypasses both with fullErrors", () => {
    const msg = `password=hunter2 ${"x".repeat(500)}`;
    expect(redactError(msg, { fullErrors: true })).toBe(msg);
  });
});

describe("fingerprint", () => {
  it("is stable across differing paths, line numbers, and timestamps", () => {
    const a = "Error: boom\n  at fn (/home/ci/run-1/app.js:10:5) 2026-06-23T10:00:00Z";
    const b = "Error: boom\n  at fn (/home/ci/run-2/app.js:42:9) 2026-06-24T11:30:00Z";
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("differs for genuinely different failures", () => {
    expect(fingerprint("Error: timeout at /a.js:1:1")).not.toBe(
      fingerprint("Error: assertion at /a.js:1:1"),
    );
  });
});

describe("makeTestError", () => {
  it("fingerprints the stack and redacts the message", () => {
    const error = makeTestError({
      message: `Failed with token ghp_${"z".repeat(36)}`,
      stack: "at fn (/a/b.js:1:1)",
    });
    expect(error.message).toContain("[REDACTED]");
    expect(error.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("falls back to the message for the fingerprint when no stack is given", () => {
    expect(makeTestError({ message: "boom" }).fingerprint).toBe(fingerprint("boom"));
  });
});
