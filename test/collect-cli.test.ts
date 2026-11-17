import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function collect(...flags: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "collect", "--repo", "owner/name", ...flags],
    { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "", NO_COLOR: "1" } },
  );
  return { status: result.status, stderr: result.stderr };
}

describe("collect flag validation", () => {
  it.each([
    [["--exclude-trigger", ","], 'Invalid --exclude-trigger ",": expected trigger event names.'],
    [["--exclude-artifact", ","], 'Invalid --exclude-artifact ",": expected artifact name globs.'],
    [["--workflow", ""], "Invalid --workflow: expected a non-empty string."],
    [["--matrix-from-artifact", "(?<x>"], "Invalid --matrix-from-artifact: not a valid regular"],
  ])("rejects %j with its own flag name before authenticating", (flags, message) => {
    const { status, stderr } = collect(...flags);
    expect(status).toBe(1);
    expect(stderr).toContain(message);
    expect(stderr).not.toContain("Authenticated");
  });
});
