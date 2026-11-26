import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TypecheckResult } from "../types.ts";

const TSC_BIN = join(import.meta.dir, "..", "..", "node_modules", "typescript", "bin", "tsc");

async function run(command: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}`.trim() };
}

function hasDevDependencies(solutionDir: string): boolean {
  const packagePath = join(solutionDir, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { devDependencies?: Record<string, string> };
    return Object.keys(parsed.devDependencies ?? {}).length > 0;
  } catch {
    return false; // the layout step already reports an unreadable package.json
  }
}

/**
 * Turns `tsc --pretty false` output into one string per diagnostic. Continuation
 * lines (indented elaborations) are kept on the diagnostic they belong to.
 */
export function parseTscOutput(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    if (/ error TS\d+: /.test(line) || /^error TS\d+: /.test(line)) errors.push(line.trimEnd());
    else if (/^\s+\S/.test(line) && errors.length > 0) errors[errors.length - 1] += `\n${line.trimEnd()}`;
  }
  return errors;
}

/**
 * `tsc --noEmit -p <solutionDir>`, after `bun install` when the solution lists
 * devDependencies and has no node_modules yet. A failed install is reported as
 * a typecheck error so the remaining steps still produce a complete score.
 */
export async function runTypecheck(solutionDir: string): Promise<TypecheckResult> {
  if (hasDevDependencies(solutionDir) && !existsSync(join(solutionDir, "node_modules"))) {
    const install = await run(["bun", "install"], solutionDir);
    if (install.exitCode !== 0) return { pass: false, errors: [`bun install failed in solution: ${install.output}`] };
  }
  const tsc = await run(["bun", TSC_BIN, "--noEmit", "--pretty", "false", "-p", solutionDir], solutionDir);
  if (tsc.exitCode === 0) return { pass: true, errors: [] };
  const errors = parseTscOutput(tsc.output);
  return { pass: false, errors: errors.length > 0 ? errors : [`tsc exited ${tsc.exitCode}: ${tsc.output}`] };
}
