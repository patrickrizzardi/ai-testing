#!/usr/bin/env bun
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadTaskConfig } from "./src/config.ts";
import { runGates } from "./src/gates/index.ts";
import { formatHuman, formatJson } from "./src/report.ts";
import { runHiddenTests } from "./src/steps/hidden-tests.ts";
import { runLayout } from "./src/steps/layout.ts";
import { runTypecheck } from "./src/steps/typecheck.ts";
import type { GradeReport } from "./src/types.ts";

const USAGE = "usage: bun grade/cli.ts <task-id> <solution-dir> [--json]";

function usageError(message: string): never {
  console.error(`grade: ${message}`);
  process.exit(2);
}

const args = Bun.argv.slice(2);
const wantsJson = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");
const unknownFlag = positional.find((arg) => arg.startsWith("--"));
if (unknownFlag) usageError(`unknown option ${unknownFlag}\n${USAGE}`);
const [taskId, solutionArgument] = positional;
if (positional.length !== 2 || taskId === undefined || solutionArgument === undefined) usageError(USAGE);

const solutionPath = resolve(solutionArgument);
if (!existsSync(solutionPath) || !statSync(solutionPath).isDirectory()) usageError(`solution directory not found: ${solutionPath}`);
const solutionDir = realpathSync(solutionPath);

const config = loadTaskConfig(taskId);
if (!config.ok) usageError(config.error);

// Steps run in a fixed order, all of them, so a failure still yields a complete score.
const layout = runLayout(solutionDir, config.value.entries);
const typecheck = await runTypecheck(solutionDir);
const gates = await runGates(solutionDir, config.value);
if (!gates.ok) usageError(gates.error);
const tests = await runHiddenTests(taskId, solutionDir);
if (!tests.ok) usageError(tests.error);

const rightFirstTime =
  layout.pass &&
  typecheck.pass &&
  gates.value.every((gate) => gate.pass) &&
  tests.value.failed === 0 &&
  tests.value.total > 0;

const report: GradeReport = {
  task: taskId,
  solutionDir,
  layout,
  typecheck,
  gates: gates.value,
  tests: tests.value,
  rightFirstTime,
};
console.log(wantsJson ? formatJson(report) : formatHuman(report));
process.exit(rightFirstTime ? 0 : 1);
