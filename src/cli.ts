#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { collectCommand } from "./commands/collect.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { reportCommand } from "./commands/report.js";

const main = defineCommand({
  meta: {
    name: "suitevitals",
    version: "0.0.0",
    description: "The vital signs of your test suite — flaky-test detection from CI artifacts.",
  },
  subCommands: {
    collect: collectCommand,
    report: reportCommand,
    dashboard: dashboardCommand,
  },
});

runMain(main);
