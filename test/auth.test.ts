import { describe, expect, it, vi } from "vitest";
import { AuthError, resolveToken } from "../src/github/auth.js";

describe("resolveToken (D8 precedence chain)", () => {
  it("prefers the explicit --token flag above all else", async () => {
    const runGhCli = vi.fn();
    const result = await resolveToken({
      token: "flag-token",
      env: { GITHUB_TOKEN: "env-token" },
      runGhCli,
    });

    expect(result).toEqual({ token: "flag-token", source: "flag" });
    expect(runGhCli).not.toHaveBeenCalled();
  });

  it("falls back to GITHUB_TOKEN when no flag is given", async () => {
    const runGhCli = vi.fn();
    const result = await resolveToken({
      env: { GITHUB_TOKEN: "env-token" },
      runGhCli,
    });

    expect(result).toEqual({ token: "env-token", source: "env" });
    expect(runGhCli).not.toHaveBeenCalled();
  });

  it("falls back to `gh auth token` when flag and env are absent", async () => {
    const result = await resolveToken({
      env: {},
      runGhCli: async () => "gh-token",
    });

    expect(result).toEqual({ token: "gh-token", source: "gh-cli" });
  });

  it("trims whitespace and ignores blank values", async () => {
    const result = await resolveToken({
      token: "   ",
      env: { GITHUB_TOKEN: "  env-token  " },
      runGhCli: async () => null,
    });

    expect(result).toEqual({ token: "env-token", source: "env" });
  });

  it("throws a clear AuthError when no source yields a token", async () => {
    await expect(resolveToken({ env: {}, runGhCli: async () => null })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("error message lists all three token sources", async () => {
    await expect(resolveToken({ env: {}, runGhCli: async () => null })).rejects.toThrow(
      /--token[\s\S]*GITHUB_TOKEN[\s\S]*gh auth login/,
    );
  });
});
