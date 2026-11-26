import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IGNORED_DIRECTORIES, isTestPath, TEST_DIRECTORIES } from "../files.ts";
import { fail, ok, type Finding, type Result } from "../types.ts";

const JSCPD_BIN = join(import.meta.dir, "..", "..", "node_modules", "jscpd", "bin", "jscpd");

interface JscpdFragment {
  name: string;
  start: number;
  end: number;
}

interface JscpdDuplicate {
  format: string;
  lines: number;
  tokens?: number;
  firstFile: JscpdFragment;
  secondFile: JscpdFragment;
}

/**
 * Parses jscpd's JSON report into one finding per clone pair, reported at the
 * later fragment (by path, then line) so the earlier one stays the "original".
 * Test files are dropped here, because jscpd ignores them only by glob.
 */
export function duplicatesToFindings(report: unknown, solutionDir: string): Finding[] {
  const duplicates = (report as { duplicates?: JscpdDuplicate[] }).duplicates ?? [];
  const toRelative = (name: string): string => {
    const prefix = solutionDir.endsWith("/") ? solutionDir : `${solutionDir}/`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  };
  const findings: Finding[] = [];
  for (const duplicate of duplicates) {
    // jscpd's first/second order depends on directory-walk timing; order by position instead.
    const [original, copy] = [duplicate.firstFile, duplicate.secondFile].sort(
      (left, right) => left.name.localeCompare(right.name) || left.start - right.start,
    ) as [JscpdFragment, JscpdFragment];
    const originalPath = toRelative(original.name);
    const copyPath = toRelative(copy.name);
    if (isTestPath(originalPath) || isTestPath(copyPath)) continue;
    const tokens = duplicate.tokens === undefined ? "" : `, ${duplicate.tokens} tokens`;
    findings.push({
      file: copyPath,
      line: copy.start,
      message: `duplicates ${originalPath}:${original.start}-${original.end} (${duplicate.lines} lines${tokens})`,
    });
  }
  return findings.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.message.localeCompare(right.message),
  );
}

/**
 * jscpd matches ignore globs against absolute paths, so each glob is anchored at
 * the solution directory: a solution that itself lives under a folder named
 * `tests` or `build` must not have all its files ignored.
 */
function ignoreGlobs(solutionDir: string): string {
  const ignoredDirectories = [...IGNORED_DIRECTORIES, ...TEST_DIRECTORIES].map((name) => `${solutionDir}/**/${name}/**`);
  const testFiles = [`${solutionDir}/**/*.test.*`, `${solutionDir}/**/*.spec.*`];
  return [...ignoredDirectories, ...testFiles].join(",");
}

/**
 * Copy-paste detection with jscpd (token based, so renamed whitespace and
 * formatting do not hide a clone). Runs as a subprocess; cost is jscpd's own,
 * roughly linear in total source size.
 */
export async function scanDuplication(solutionDir: string, minTokens: number): Promise<Result<Finding[]>> {
  const outputDirectory = mkdtempSync(join(tmpdir(), "grade-jscpd-"));
  try {
    const process = Bun.spawn(
      [
        "bun",
        JSCPD_BIN,
        solutionDir,
        "--min-tokens",
        String(minTokens),
        "--min-lines",
        "1",
        "--format",
        "typescript,tsx",
        "--ignore",
        ignoreGlobs(solutionDir),
        "--reporters",
        "json",
        "--output",
        outputDirectory,
        "--silent",
        "--absolute",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited]);
    if (exitCode !== 0) return fail(`jscpd exited ${exitCode}: ${stderr.trim()}`);
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(join(outputDirectory, "jscpd-report.json"), "utf8"));
    } catch (error) {
      return fail(`jscpd produced no readable report: ${error instanceof Error ? error.message : String(error)}`);
    }
    return ok(duplicatesToFindings(report, solutionDir));
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}
