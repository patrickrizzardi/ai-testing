import { describe, expect, test } from "bun:test";
import { scanDuctTape } from "./duct-tape.ts";

// High tier (validator). Bugs caught: a marker or suppression slipping through (false negative),
// or text inside strings / prose / identifiers failing a clean solution (false positive).
const scan = (text: string) => scanDuctTape([{ path: "src/a.ts", text }]);

const positives: [name: string, code: string, messagePart: string][] = [
  ["TODO comment", "// TODO: later\nexport const a = 1;", "TODO"],
  ["FIXME comment", "export const a = 1; // FIXME", "FIXME"],
  ["HACK block comment", "/* HACK around it */\nexport const a = 1;", "HACK"],
  ["XXX comment", "// XXX\nexport const a = 1;", "XXX"],
  ["comment as the only content of a block", "export function f() {\n  // TODO\n}", "TODO"],
  ["comment at end of file", "export const a = 1;\n// FIXME", "FIXME"],
  ["@ts-ignore", "// @ts-ignore\nexport const a: number = 'x';", "@ts-ignore"],
  ["@ts-expect-error", "// @ts-expect-error\nexport const a: number = 'x';", "@ts-expect-error"],
  ["eslint-disable", "/* eslint-disable no-console */\nexport const a = 1;", "eslint-disable"],
  ["eslint-disable-next-line", "// eslint-disable-next-line\nexport const a = 1;", "eslint-disable"],
  ["any annotation", "export const a: any = 1;", "`any`"],
  ["any parameter", "export function f(value: any) { return value; }", "`any`"],
  ["as any", "export const a = (1 as any);", "`any`"],
  ["any[]", "export const a: any[] = [];", "`any`"],
  ["generic any", "export const a: Array<any> = [];", "`any`"],
  ["angle-bracket any", "export const a = <any>1;", "`any`"],
];

const negatives: [name: string, code: string][] = [
  ["clean code", "export const a = 1;"],
  ["marker inside a string", "export const a = 'TODO: later';"],
  ["comment-like text inside a string", "export const a = '// FIXME';"],
  ["comment-like text inside a template literal", "export const a = `// HACK ${1}`;"],
  ["identifier containing a marker", "export const TODOS = 1; export const hackathon = 2;"],
  ["lower-case prose", "// this is a hack in the everyday sense\nexport const a = 1;"],
  ["unknown instead of any", "export const a: unknown = 1;"],
  ["identifier named any", "export const any = 1;"],
  ["any inside a string type", "export const a: 'any' = 'any';"],
  ["any inside a JSDoc line", "/** returns any value // not a marker */\nexport const a = 1;"],
  ["ordinary suppression-free comment", "// ts is great\nexport const a = 1;"],
];

describe("duct-tape scanner", () => {
  test.each(positives)("flags %s", (_name, code, messagePart) => {
    const findings = scan(code);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((finding) => finding.message.includes(messagePart))).toBe(true);
  });

  test.each(negatives)("passes %s", (_name, code) => {
    expect(scan(code)).toEqual([]);
  });

  test("names file and 1-based line", () => {
    expect(scan("export const a = 1;\n\n// TODO soon")).toEqual([{ file: "src/a.ts", line: 3, message: "TODO comment" }]);
  });
});
