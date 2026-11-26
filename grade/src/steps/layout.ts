import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, LayoutResult } from "../types.ts";

function lineOfKey(text: string, key: string): number {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(`"${key}"`));
  return index === -1 ? 1 : index + 1;
}

/**
 * Pure check of the layout contract over already-read inputs: every entry file
 * exists, and package.json is valid JSON without runtime `dependencies`.
 */
export function checkLayout(existingFiles: ReadonlySet<string>, entries: string[], packageJsonText: string | undefined): LayoutResult {
  const findings: Finding[] = [];
  for (const entry of entries) {
    if (!existingFiles.has(entry)) findings.push({ file: entry, line: 1, message: "required entry file is missing" });
  }
  if (packageJsonText === undefined) {
    findings.push({ file: "package.json", line: 1, message: "package.json is missing" });
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(packageJsonText);
    } catch {
      findings.push({ file: "package.json", line: 1, message: "package.json is not valid JSON" });
    }
    if (typeof parsed === "object" && parsed !== null && "dependencies" in parsed) {
      const dependencies = (parsed as { dependencies: unknown }).dependencies;
      const names = typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
      if (names.length > 0 || typeof dependencies !== "object" || dependencies === null) {
        const listed = names.length > 0 ? `: ${names.join(", ")}` : "";
        findings.push({
          file: "package.json",
          line: lineOfKey(packageJsonText, "dependencies"),
          message: `package.json must not have "dependencies"${listed}`,
        });
      }
    }
  }
  return { pass: findings.length === 0, findings };
}

export function runLayout(solutionDir: string, entries: string[]): LayoutResult {
  const existing = new Set(entries.filter((entry) => existsSync(join(solutionDir, entry))));
  const packagePath = join(solutionDir, "package.json");
  const packageJsonText = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : undefined;
  return checkLayout(existing, entries, packageJsonText);
}
