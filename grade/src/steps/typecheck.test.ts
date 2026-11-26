import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTscOutput, runTypecheck } from "./typecheck.ts";

// High tier (parser). Bug caught: multi-line diagnostics split into bogus entries, or noise counted as errors.
test("keeps one entry per diagnostic with its continuation lines", () => {
  const output = [
    "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts(4,3): error TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.",
    "  Types of property 'x' are incompatible.",
    "error TS5057: Cannot find a tsconfig.json file at the specified directory: '/x'.",
  ].join("\n");
  expect(parseTscOutput(output)).toEqual([
    "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts(4,3): error TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.\n  Types of property 'x' are incompatible.",
    "error TS5057: Cannot find a tsconfig.json file at the specified directory: '/x'.",
  ]);
  expect(parseTscOutput("")).toEqual([]);
});

// Bug caught: type-checking with grade's own TypeScript 5.9 instead of the solution's pin (wrong grades).
// selftest/compiler sets `stableTypeOrdering`, an option only TypeScript 7 knows. Tier: High (grading correctness).
test("type-checks with the compiler the solution pins and leaves no lockfile", async () => {
  const solutionDir = join(import.meta.dir, "..", "..", "selftest", "compiler");
  const result = await runTypecheck(solutionDir);
  expect(result).toEqual({ pass: true, compiler: "7.0.2", errors: [] });
  expect(existsSync(join(solutionDir, "bun.lock"))).toBe(false);
}, 120_000);

// Bug caught: an uninstallable pin crashing the grader (exit 2) instead of a named typecheck failure. Tier: High.
test("reports a pin that cannot be installed as a typecheck failure", async () => {
  const solutionDir = mkdtempSync(join(tmpdir(), "grade-typecheck-"));
  writeFileSync(
    join(solutionDir, "package.json"),
    JSON.stringify({ devDependencies: { typescript: "0.0.0-no-such-version" } }),
  );
  try {
    const result = await runTypecheck(solutionDir);
    expect(result.pass).toBe(false);
    expect(result.compiler).toBeNull();
    expect(result.errors[0]).toStartWith("bun install failed in solution:");
    expect(existsSync(join(solutionDir, "bun.lock"))).toBe(false);
  } finally {
    rmSync(solutionDir, { recursive: true, force: true });
  }
}, 120_000);
