import { describe, expect, it } from "vitest";
import { parseConfig, resolveTargets } from "../src/collect/config.js";

describe("parseConfig", () => {
  it("parses defaults and a mixed list of string and object entries", () => {
    const config = parseConfig(
      JSON.stringify({
        hoursBack: 72,
        concurrency: 5,
        repos: ["owner/a", { repo: "owner/b", hoursBack: 168, concurrency: 2 }],
      }),
    );
    expect(config.hoursBack).toBe(72);
    expect(config.concurrency).toBe(5);
    expect(config.repos).toEqual(["owner/a", { repo: "owner/b", hoursBack: 168, concurrency: 2 }]);
  });

  it("rejects malformed JSON, non-objects, and a non-array repos field", () => {
    expect(() => parseConfig("{not json")).toThrow(/not valid JSON/);
    expect(() => parseConfig("[]")).toThrow(/expected a JSON object/);
    expect(() => parseConfig('{"repos":{}}')).toThrow(/"repos" must be an array/);
  });

  it("rejects an entry without a repo and bad override values", () => {
    expect(() => parseConfig('{"repos":[{"hoursBack":1}]}')).toThrow(/expected "owner\/name"/);
    expect(() => parseConfig('{"repos":[{"repo":"o/r","hoursBack":0}]}')).toThrow(
      /hoursBack: expected a positive number/,
    );
    expect(() => parseConfig('{"repos":[{"repo":"o/r","concurrency":1.5}]}')).toThrow(
      /concurrency: expected a positive integer/,
    );
    expect(() => parseConfig('{"repos":[],"hoursBack":-3}')).toThrow(/expected a positive number/);
  });

  it("parses and validates workflow and excludeTriggers", () => {
    const config = parseConfig(
      JSON.stringify({
        workflow: "CI",
        excludeTriggers: ["pull_request"],
        repos: [{ repo: "o/r", workflow: "e2e-*", excludeTriggers: ["schedule"] }],
      }),
    );
    expect(config.workflow).toBe("CI");
    expect(config.excludeTriggers).toEqual(["pull_request"]);
    expect(config.repos[0]).toMatchObject({ workflow: "e2e-*", excludeTriggers: ["schedule"] });

    expect(() => parseConfig('{"repos":[],"workflow":""}')).toThrow(/non-empty string/);
    expect(() => parseConfig('{"repos":[],"excludeTriggers":[]}')).toThrow(/non-empty strings/);
    expect(() => parseConfig('{"repos":[{"repo":"o/r","excludeTriggers":[1]}]}')).toThrow(
      /non-empty strings/,
    );
  });
});

describe("resolveTargets", () => {
  const base = { cliRepos: [] as string[], defaultConcurrency: 5 };

  it("applies most-specific-wins precedence per field", () => {
    const targets = resolveTargets({
      ...base,
      cliHoursBack: 24,
      config: {
        hoursBack: 100,
        concurrency: 8,
        repos: [{ repo: "owner/override", hoursBack: 168 }, "owner/inherits"],
      },
    });

    const override = targets.find((t) => t.slug === "owner/override");
    const inherits = targets.find((t) => t.slug === "owner/inherits");
    // per-repo config beats the CLI flag…
    expect(override?.hoursBack).toBe(168);
    // …and a repo with no per-repo value falls through to the CLI flag.
    expect(inherits?.hoursBack).toBe(24);
    // concurrency has no CLI/per-repo value, so the config-level default wins over the built-in.
    expect(inherits?.concurrency).toBe(8);
  });

  it("falls back to the built-in concurrency when nothing sets it", () => {
    const [target] = resolveTargets({ ...base, cliRepos: ["owner/a"] });
    expect(target?.concurrency).toBe(5);
    expect(target?.hoursBack).toBeUndefined();
  });

  it("resolves matrixFromArtifact most-specific-wins", () => {
    const targets = resolveTargets({
      ...base,
      cliMatrixFromArtifact: "cli-(?<browser>.+)",
      config: {
        matrixFromArtifact: "default-(?<browser>.+)",
        repos: [
          { repo: "owner/override", matrixFromArtifact: "own-(?<browser>.+)" },
          "owner/inherits",
        ],
      },
    });

    expect(targets.find((t) => t.slug === "owner/override")?.matrixFromArtifact).toBe(
      "own-(?<browser>.+)",
    );
    expect(targets.find((t) => t.slug === "owner/inherits")?.matrixFromArtifact).toBe(
      "cli-(?<browser>.+)",
    );
  });

  it("rejects a bad matrixFromArtifact at parse time, naming the key", () => {
    // Compiling at config-parse time means a bad regex fails before any network work, with
    // the offending key named — not mid-collect on the first artifact.
    expect(() => parseConfig('{"repos":[],"matrixFromArtifact":"no-groups-(.+)"}')).toThrow(
      /named group/,
    );
    expect(() =>
      parseConfig('{"repos":[{"repo":"o/r","matrixFromArtifact":"(?<b>[a-z"}]}'),
    ).toThrow(/repos\[0\] matrixFromArtifact/);
  });

  it("resolves workflow and excludeTriggers most-specific-wins", () => {
    const targets = resolveTargets({
      ...base,
      cliWorkflow: "CI",
      cliExcludeTriggers: ["pull_request"],
      config: {
        workflow: "any",
        repos: [{ repo: "owner/override", workflow: "e2e-*" }, "owner/inherits"],
      },
    });

    // per-repo config beats the CLI flag; a repo without one falls through to the CLI flag,
    // which beats the config-level default.
    expect(targets.find((t) => t.slug === "owner/override")?.workflow).toBe("e2e-*");
    expect(targets.find((t) => t.slug === "owner/inherits")?.workflow).toBe("CI");
    expect(targets.find((t) => t.slug === "owner/inherits")?.excludeTriggers).toEqual([
      "pull_request",
    ]);
  });

  it("de-duplicates a repo named in both config and CLI, keeping the config entry", () => {
    const targets = resolveTargets({
      ...base,
      cliRepos: ["owner/dup", "owner/cli-only"],
      config: { repos: [{ repo: "owner/dup", concurrency: 2 }, "owner/config-only"] },
    });

    expect(targets.map((t) => t.slug)).toEqual([
      "owner/dup",
      "owner/config-only",
      "owner/cli-only",
    ]);
    // the surviving entry is the config one, so its per-repo override stands.
    expect(targets.find((t) => t.slug === "owner/dup")?.concurrency).toBe(2);
  });

  it("throws when no repos are supplied, and on a malformed repo ref", () => {
    expect(() => resolveTargets(base)).toThrow(/No repositories to collect/);
    expect(() => resolveTargets({ ...base, cliRepos: ["not-a-repo"] })).toThrow(/owner\/name/);
  });
});
