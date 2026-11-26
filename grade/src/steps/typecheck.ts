import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TypecheckResult } from "../types.ts";

async function run(command: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}`.trim() };
}

function pinnedTypescript(solutionDir: string): string | undefined {
  const packagePath = join(solutionDir, "package.json");
  if (!existsSync(packagePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { devDependencies?: Record<string, string> };
    return parsed.devDependencies?.typescript;
  } catch {
    return undefined; // the layout step already reports an unreadable package.json
  }
}

function installedCompilerVersion(solutionDir: string): string | undefined {
  const manifestPath = join(solutionDir, "node_modules", "typescript", "package.json");
  if (!existsSync(manifestPath)) return undefined;
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
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

const LOCKFILE_NAMES = ["bun.lock", "bun.lockb"];

/**
 * Installs the solution's devDependencies unless its pinned compiler is already
 * in node_modules. Lockfiles the install creates are removed again, so a run
 * leaves no untracked files behind. Returns the install failure, if any.
 */
async function installDevDependencies(solutionDir: string): Promise<string | undefined> {
  if (installedCompilerVersion(solutionDir) !== undefined) return undefined;
  const lockfilesBefore = LOCKFILE_NAMES.filter((name) => existsSync(join(solutionDir, name)));
  const install = await run(["bun", "install"], solutionDir);
  for (const name of LOCKFILE_NAMES) {
    if (!lockfilesBefore.includes(name)) rmSync(join(solutionDir, name), { force: true });
  }
  return install.exitCode === 0 ? undefined : install.output;
}

/**
 * Type-checks with the compiler the solution pins in `devDependencies.typescript`
 * (installed with `bun install` when missing) and the solution's own tsconfig.json.
 * `compiler` is the installed version, or null when none could be installed. A
 * missing pin or failed install is a typecheck error so the remaining steps
 * still produce a complete score.
 */
export async function runTypecheck(solutionDir: string): Promise<TypecheckResult> {
  if (pinnedTypescript(solutionDir) === undefined) {
    return { pass: false, compiler: null, errors: ["package.json does not pin typescript in devDependencies"] };
  }
  const installFailure = await installDevDependencies(solutionDir);
  if (installFailure !== undefined) {
    return { pass: false, compiler: null, errors: [`bun install failed in solution: ${installFailure}`] };
  }
  const compiler = installedCompilerVersion(solutionDir);
  if (compiler === undefined) {
    return { pass: false, compiler: null, errors: ["bun install did not provide the pinned typescript"] };
  }
  const tsc = await run(
    ["bun", join(solutionDir, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--pretty", "false", "-p", solutionDir],
    solutionDir,
  );
  if (tsc.exitCode === 0) return { pass: true, compiler, errors: [] };
  const errors = parseTscOutput(tsc.output);
  return { pass: false, compiler, errors: errors.length > 0 ? errors : [`tsc exited ${tsc.exitCode}: ${tsc.output}`] };
}
