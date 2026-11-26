import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fail, ok, type Result, type TestsResult } from "../types.ts";
import { parseJunit } from "./junit.ts";

const GRADE_DIRECTORY = join(import.meta.dir, "..", "..");
const HIDDEN_DIRECTORY = join(GRADE_DIRECTORY, "hidden");
const TEST_FILE_TIMEOUT_MS = 120_000;

function findTestFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findTestFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(fullPath);
  }
  return found.sort();
}

/** Counts in bun's text summary, e.g. "2 errors": failures that never reach the JUnit report. */
function unhandledErrorCount(output: string): number {
  const match = /^\s*(\d+) errors?\s*$/m.exec(output);
  return match ? Number(match[1]) : 0;
}

async function runTestFile(testFile: string, displayName: string, solutionDir: string): Promise<TestsResult> {
  const reportDirectory = mkdtempSync(join(tmpdir(), "grade-junit-"));
  const reportPath = join(reportDirectory, "report.xml");
  try {
    const process = Bun.spawn(["bun", "test", testFile, "--reporter=junit", `--reporter-outfile=${reportPath}`], {
      cwd: GRADE_DIRECTORY,
      env: { ...Bun.env, SOLUTION_DIR: solutionDir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: TEST_FILE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const result = existsSync(reportPath)
      ? parseJunit(readFileSync(reportPath, "utf8"), displayName)
      : { passed: 0, failed: 0, total: 0, failures: [] as string[] };
    const extraFailures: string[] = [];
    if (process.signalCode === "SIGKILL") {
      extraFailures.push(`${displayName} (timed out after ${TEST_FILE_TIMEOUT_MS / 1000}s)`);
    } else {
      const unhandled = unhandledErrorCount(`${stdout}\n${stderr}`);
      for (let index = 0; index < unhandled; index += 1) extraFailures.push(`${displayName} (error outside a test, e.g. while loading)`);
      if (exitCode !== 0 && result.failed === 0 && unhandled === 0) extraFailures.push(`${displayName} (bun test exited ${exitCode})`);
    }
    return {
      passed: result.passed,
      failed: result.failed + extraFailures.length,
      total: result.total + extraFailures.length,
      failures: [...result.failures, ...extraFailures],
    };
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

/**
 * Runs each hidden test file in its own `bun test` process with SOLUTION_DIR set.
 * Files run one after another, not in parallel: they exercise one solution that
 * may bind fixed ports or share a database file. A file that fails to load or
 * times out is reported as a failure instead of vanishing from the totals.
 */
export async function runHiddenTests(taskId: string, solutionDir: string): Promise<Result<TestsResult>> {
  const taskDirectory = join(HIDDEN_DIRECTORY, taskId);
  if (!existsSync(taskDirectory) || !statSync(taskDirectory).isDirectory()) {
    return fail(`hidden tests for task "${taskId}" not found: ${taskDirectory} does not exist`);
  }
  const testFiles = findTestFiles(taskDirectory);
  if (testFiles.length === 0) return fail(`hidden tests for task "${taskId}" not found: no *.test.ts under ${taskDirectory}`);

  const total: TestsResult = { passed: 0, failed: 0, total: 0, failures: [] };
  for (const testFile of testFiles) {
    const result = await runTestFile(testFile, relative(taskDirectory, testFile).split("\\").join("/"), solutionDir);
    total.passed += result.passed;
    total.failed += result.failed;
    total.total += result.total;
    total.failures.push(...result.failures);
  }
  return ok(total);
}
