import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "./types.ts";

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;
export const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__"]);
export const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  return TEST_FILE.test(path) || segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment));
}

/**
 * Every TypeScript file under the solution directory, ignoring dependency and
 * build folders, sorted by path so scans are deterministic.
 * O(f log f) time for f files.
 */
export function collectSourceFiles(solutionDir: string): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(fullPath);
      } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) {
        const path = relative(solutionDir, fullPath).split("\\").join("/");
        files.push({ path, text: readFileSync(fullPath, "utf8") });
      }
    }
  };
  visit(solutionDir);
  return files.sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0));
}
