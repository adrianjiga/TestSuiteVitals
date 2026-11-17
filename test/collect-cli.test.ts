import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "suitevitals-cli-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function collect(...flags: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "collect",
      "--repo",
      "owner/name",
      "--token",
      "not-a-real-token",
      "--state-file",
      join(scratch, "state.json"),
      "--data-dir",
      join(scratch, "data"),
      ...flags,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, GITHUB_TOKEN: "", GH_CONFIG_DIR: scratch, NO_COLOR: "1" },
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("collect flag validation", () => {
  it.each([
    [["--exclude-trigger", ","], 'Invalid --exclude-trigger ",": expected trigger event names.'],
    [["--exclude-artifact", ","], 'Invalid --exclude-artifact ",": expected artifact name globs.'],
    [["--workflow", ""], "Invalid --workflow: expected a non-empty string."],
    [["--matrix-from-artifact", "(?<x>"], "Invalid --matrix-from-artifact: not a valid regular"],
  ])(
    "rejects %j with its own flag name before authenticating",
    (flags, message) => {
      const { status, output } = collect(...flags);
      expect(status).toBe(1);
      expect(output).toContain(message);
      expect(output).not.toContain("Authenticated");
    },
    30_000,
  );
});

describe("report and dashboard flag validation", () => {
  it.each([["report"], ["dashboard"]])(
    "%s rejects a blank --workflow",
    (command) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", command, "--repo", "owner/name", "--workflow", " "],
        { encoding: "utf8", timeout: 20_000, env: { ...process.env, NO_COLOR: "1" } },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Invalid --workflow: expected a non-empty string.",
      );
    },
    30_000,
  );
});
