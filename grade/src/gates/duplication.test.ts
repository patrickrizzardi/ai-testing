import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicatesToFindings, scanDuplication } from "./duplication.ts";

// High tier (validator). Bugs caught: copy-paste passing the gate; clean code failing it; the
// threshold being ignored; nondeterministic first/second order making the table flaky.
const clone = (functionName: string): string => `export function ${functionName}(values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 10) { total += value * 2; } else { total -= value; }
    if (value % 3 === 0) { total += 3; }
  }
  return total + values.length * 7 - Math.max(...values) + Math.min(...values);
}
`;

const temporaryDirectories: string[] = [];
function makeSolution(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "grade-dup-test-"));
  temporaryDirectories.push(directory);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("duplication scanner (jscpd)", () => {
  test("flags a pasted function across two files, reported at the later file", async () => {
    const directory = makeSolution({ "src/a.ts": clone("first"), "src/b.ts": clone("second") });
    const result = await scanDuplication(directory, 60);
    expect(result).toEqual({
      ok: true,
      value: [{ file: "src/b.ts", line: 1, message: expect.stringContaining("duplicates src/a.ts:1-") }],
    });
  });

  test("passes distinct code", async () => {
    const directory = makeSolution({
      "src/a.ts": clone("first"),
      "src/b.ts": "export const greeting = (name: string): string => `hello ${name}`;\n",
    });
    expect(await scanDuplication(directory, 60)).toEqual({ ok: true, value: [] });
  });

  test("honours the token threshold", async () => {
    const directory = makeSolution({ "src/a.ts": clone("first"), "src/b.ts": clone("second") });
    expect(await scanDuplication(directory, 400)).toEqual({ ok: true, value: [] });
  });

  test("ignores clones that involve test files", async () => {
    const directory = makeSolution({ "src/a.ts": clone("first"), "src/a.test.ts": clone("second") });
    expect(await scanDuplication(directory, 60)).toEqual({ ok: true, value: [] });
  });
});

describe("duplicatesToFindings", () => {
  const fragment = (name: string, start: number) => ({ name, start, end: start + 9 });
  test.each([
    ["first/second as jscpd gave them", "/sol/src/a.ts", "/sol/src/b.ts"],
    ["first/second swapped", "/sol/src/b.ts", "/sol/src/a.ts"],
  ])("gives the same finding regardless of jscpd's pair order: %s", (_name, firstName, secondName) => {
    const report = { duplicates: [{ format: "typescript", lines: 10, tokens: 80, firstFile: fragment(firstName, 3), secondFile: fragment(secondName, 3) }] };
    expect(duplicatesToFindings(report, "/sol")).toEqual([
      { file: "src/b.ts", line: 3, message: "duplicates src/a.ts:3-12 (10 lines, 80 tokens)" },
    ]);
  });

  test("an empty report has no findings", () => {
    expect(duplicatesToFindings({ duplicates: [] }, "/sol")).toEqual([]);
  });
});
