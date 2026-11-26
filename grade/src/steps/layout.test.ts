import { describe, expect, test } from "bun:test";
import { checkLayout } from "./layout.ts";

// High tier (validator). Bugs caught: a missing entry or a runtime dependency passing; devDependencies failing.
const entries = ["src/app.ts", "src/main.ts"];
const present = new Set(entries);

describe("checkLayout", () => {
  test("passes entries present and only devDependencies", () => {
    expect(checkLayout(present, entries, '{ "name": "x", "devDependencies": { "typescript": "^5" } }')).toEqual({ pass: true, findings: [] });
  });

  test("passes an empty dependencies object", () => {
    expect(checkLayout(present, entries, '{ "dependencies": {} }').pass).toBe(true);
  });

  test.each([
    ["missing entry", new Set(["src/app.ts"]), "{}", { file: "src/main.ts", line: 1, message: "required entry file is missing" }],
    ["missing package.json", present, undefined, { file: "package.json", line: 1, message: "package.json is missing" }],
    ["invalid package.json", present, "{ nope", { file: "package.json", line: 1, message: "package.json is not valid JSON" }],
    [
      "runtime dependency, reported at its line",
      present,
      '{\n  "name": "x",\n  "dependencies": {\n    "hono": "^4"\n  }\n}',
      { file: "package.json", line: 3, message: 'package.json must not have "dependencies": hono' },
    ],
    ["non-object dependencies", present, '{ "dependencies": null }', { file: "package.json", line: 1, message: 'package.json must not have "dependencies"' }],
  ] as const)("fails %s", (_name, existing, packageJson, expected) => {
    const result = checkLayout(existing, entries, packageJson);
    expect(result.pass).toBe(false);
    expect(result.findings).toEqual([expected]);
  });
});
