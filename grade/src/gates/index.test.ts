import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGates } from "./index.ts";

// High tier (validator scope). Bug caught: a gate scanning the wrong set of files: tests must
// fail duct-tape but must not fail swallowed-error / sql-injection; node_modules is never scanned.
const directory = mkdtempSync(join(tmpdir(), "grade-gates-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(join(directory, path, ".."), { recursive: true });
  writeFileSync(join(directory, path), text);
}

test("scopes each gate to the right files and orders results as configured", async () => {
  write("src/app.ts", "export const a = 1;\n");
  write("src/app.test.ts", "// TODO test\nexport const b: any = 1;\ntry { b; } catch {}\ndb.query(`SELECT ${b}`);\n");
  write("node_modules/dep/index.ts", "// TODO vendored\n");

  const result = await runGates(directory, {
    entries: [],
    gates: ["sql-injection", "swallowed-error", "duct-tape"],
    duplicationMinTokens: 60,
  });
  expect(result).toEqual({
    ok: true,
    value: [
      { id: "sql-injection", pass: true, findings: [] },
      { id: "swallowed-error", pass: true, findings: [] },
      {
        id: "duct-tape",
        pass: false,
        findings: [
          { file: "src/app.test.ts", line: 1, message: "TODO comment" },
          { file: "src/app.test.ts", line: 2, message: "`any` type" },
        ],
      },
    ],
  });
});
