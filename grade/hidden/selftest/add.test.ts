import { expect, test } from "bun:test";
import { join } from "node:path";

// Fixture for `bun grade/cli.ts selftest grade/selftest/<case>`; not a task.
const solutionDir = process.env.SOLUTION_DIR;
if (!solutionDir) throw new Error("SOLUTION_DIR is not set");
const { add } = await import(join(solutionDir, "src/index.ts"));

test("adds positives", () => {
  expect(add(2, 3)).toBe(5);
});

test("adds a negative", () => {
  expect(add(-1, 1)).toBe(0);
});
