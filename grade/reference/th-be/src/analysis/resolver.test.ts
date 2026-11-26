import { describe, expect, test } from "bun:test";
import { analyze } from ".";
import { lex } from "../syntax/lexer";
import { parse } from "../syntax/parser";

function staticErrorOf(source: string): { line: number; column: number } | null {
  const parsed = parse(lex(source));
  if (!parsed.ok) throw new Error(`unexpected syntax error: ${parsed.error.message}`);
  const analysis = analyze(parsed.value);
  return analysis.ok ? null : { line: analysis.error.line, column: analysis.error.column };
}

describe("static errors (spec 4.2)", () => {
  test.each([
    ["an assignment to a call result", "f(x) = 1;", 1, 6],
    ["an assignment to a parenthesised name", "(a) = 1;", 1, 5],
    ["an assignment to an arithmetic expression", "1 + 2 = 3;", 1, 7],
    ["an assignment to a unary expression", "-a = 1;", 1, 4],
    ["a second let of a name in one scope", "let a = 1;\nlet a = 2;", 2, 5],
    ["a let after a parameter of the same name", "fn f(a) { let a = 1; }", 1, 15],
    ["a repeated parameter", "fn f(a, a) { }", 1, 9],
    ["a function and a let of one name", "fn a() { }\nlet a = 1;", 2, 5],
    ["a loop variable repeated by a let in the body", "for v in [] { let v = 1; }", 1, 19],
    ["an assignment to a function", "fn f() { }\nf = 1;", 2, 1],
    ["an assignment to a builtin", "print = 1;", 1, 1],
    ["return at program level", "return 1;", 1, 1],
    ["return inside a block outside any function", "if true { return; }", 1, 11],
    ["a repeated record field", "let r = {a: 1, b: 2, a: 3};", 1, 22],
  ])("%s", (_label, source, line, column) => {
    expect(staticErrorOf(source)).toEqual({ line, column });
  });

  test.each([
    ["a valid target ending in a field after a call", "fn f() { return {}; }\nf().y = 1;"],
    ["a parenthesised base with a field suffix", "let a = {};\n(a).y = 1;"],
    ["a shadowing let in a nested block", "let a = 1;\nif true { let a = 2; }"],
    ["a loop variable that shadows an outer name", "let v = 1;\nfor v in [] { }"],
    ["an unresolved name is not a static error", "x = 1;"],
    ["return inside a function nested in a block", "if true { fn f() { return 1; } }"],
    ["a nested function reusing a parameter name of its parent", "fn f(a) { fn g(a) { return a; } }"],
    ["an assignment to a parameter", "fn f(a) { a = 1; }"],
  ])("accepts %s", (_label, source) => {
    expect(staticErrorOf(source)).toBeNull();
  });

  test("with several errors the one with the smallest position is reported, whatever rule it breaks", () => {
    expect(staticErrorOf("return 1;\nlet a = 1;\nlet a = 2;")).toEqual({ line: 1, column: 1 });
    expect(staticErrorOf("let a = 1;\nlet a = 2;\n1 = 2;")).toEqual({ line: 2, column: 5 });
    expect(staticErrorOf("let r = {x: 1, x: 2};\nfn f() { }\nf = 1;")).toEqual({ line: 1, column: 16 });
  });
});
