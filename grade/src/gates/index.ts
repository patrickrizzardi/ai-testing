import type { GateId, TaskConfig } from "../config.ts";
import { collectSourceFiles, isTestPath } from "../files.ts";
import { fail, ok, type Finding, type GateResult, type Result, type SourceFile } from "../types.ts";
import { scanDuctTape } from "./duct-tape.ts";
import { scanDuplication } from "./duplication.ts";
import { scanSqlInjection } from "./sql-injection.ts";
import { scanSwallowedError } from "./swallowed-error.ts";

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.message.localeCompare(right.message));
}

/** Gates that scan source text; duct-tape alone also covers test files. */
const TEXT_SCANNERS: Record<Exclude<GateId, "duplication">, { includeTests: boolean; scan: (files: SourceFile[]) => Finding[] }> = {
  "duct-tape": { includeTests: true, scan: scanDuctTape },
  "swallowed-error": { includeTests: false, scan: scanSwallowedError },
  "sql-injection": { includeTests: false, scan: scanSqlInjection },
};

/** Runs every gate the task config lists, in the config's order. */
export async function runGates(solutionDir: string, config: TaskConfig): Promise<Result<GateResult[]>> {
  const allFiles = collectSourceFiles(solutionDir);
  const sourceFiles = allFiles.filter((file) => !isTestPath(file.path));
  const results: GateResult[] = [];
  for (const id of config.gates) {
    let findings: Finding[];
    if (id === "duplication") {
      // jscpd writes no report when it finds nothing to scan; no source means no clones.
      if (sourceFiles.length === 0) {
        results.push({ id, pass: true, findings: [] });
        continue;
      }
      const duplication = await scanDuplication(solutionDir, config.duplicationMinTokens);
      if (!duplication.ok) return fail(`duplication gate: ${duplication.error}`);
      findings = duplication.value;
    } else {
      const scanner = TEXT_SCANNERS[id];
      findings = scanner.scan(scanner.includeTests ? allFiles : sourceFiles);
    }
    results.push({ id, pass: findings.length === 0, findings: sortFindings(findings) });
  }
  return ok(results);
}
