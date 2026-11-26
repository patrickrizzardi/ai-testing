import { expect, test } from "bun:test";
import { parseTscOutput } from "./typecheck.ts";

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
