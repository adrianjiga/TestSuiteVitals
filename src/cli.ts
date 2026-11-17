#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { type ArgsDef, type CommandDef, defineCommand, runMain } from "citty";
import { colorSupported, createPalette } from "./colors.js";
import { collectCommand } from "./commands/collect.js";
import { compactCommand } from "./commands/compact.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { doctorCommand } from "./commands/doctor.js";
import { pruneCommand } from "./commands/prune.js";
import { reportCommand } from "./commands/report.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * Prints a command's failure as one line and exits 1, instead of citty's default of dumping the
 * stack trace — an invalid flag or a missing repo is a user error, not a crash. Set
 * `SUITEVITALS_DEBUG=1` to get the stack back when reporting a bug.
 */
function withCleanErrors<T extends ArgsDef>(command: CommandDef<T>): CommandDef<T> {
  const { run } = command;
  if (!run) {
    return command;
  }
  return {
    ...command,
    run: async (context) => {
      try {
        return await run(context);
      } catch (error) {
        if (process.env.SUITEVITALS_DEBUG) {
          console.error(error);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error(createPalette(colorSupported).bad(`Error: ${message}`));
        }
        process.exitCode = 1;
      }
    },
  };
}

const main = defineCommand({
  meta: {
    name: "suitevitals",
    version,
    description: "The vital signs of your test suite — flaky-test detection from CI artifacts.",
  },
  subCommands: {
    collect: withCleanErrors(collectCommand),
    report: withCleanErrors(reportCommand),
    dashboard: withCleanErrors(dashboardCommand),
    compact: withCleanErrors(compactCommand),
    prune: withCleanErrors(pruneCommand),
    doctor: withCleanErrors(doctorCommand),
  },
});

runMain(main);
