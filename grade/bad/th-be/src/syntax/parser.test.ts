import { describe, expect, test } from "bun:test";
import type { Expression, Statement } from "./ast";
import { lex } from "./lexer";
import { parse } from "./parser";

function parseStatements(source: string): Statement[] {
  const parsed = parse(lex(source));
  if (!parsed.ok) throw new Error(`unexpected syntax error: ${parsed.error.message}`);
  return [...parsed.value.statements];
}

/** An expression as a fully parenthesised string, so tests state precedence and associativity directly. */
function shape(expression: Expression): string {
  switch (expression.kind) {
    case "IntegerLiteral":
    case "BooleanLiteral":
      return String(expression.value);
    case "StringLiteral":
      return JSON.stringify(expression.value);
    case "NilLiteral":
      return "nil";
    case "Identifier":
      return expression.name;
    case "ArrayLiteral":
      return `[${expression.elements.map(shape).join(",")}]`;
    case "RecordLiteral":
      return `{${expression.fields.map((field) => `${field.name}:${shape(field.value)}`).join(",")}}`;
    case "Group":
      return `group(${shape(expression.inner)})`;
    case "Unary":
      return `(${expression.operator}${shape(expression.operand)})`;
    case "Binary":
      return `(${shape(expression.left)} ${expression.operator} ${shape(expression.right)})`;
    case "Call":
      return `${shape(expression.callee)}(${expression.argumentExpressions.map(shape).join(",")})`;
    case "Index":
      return `${shape(expression.target)}[${shape(expression.index)}]`;
    case "Field":
      return `${shape(expression.target)}.${expression.name}`;
  }
}

function expressionOf(source: string): string {
  const [statement] = parseStatements(`${source};`);
  if (statement?.kind !== "Expression") throw new Error("not an expression statement");
  return shape(statement.expression);
}

function syntaxErrorOf(source: string): { line: number; column: number } {
  const parsed = parse(lex(source));
  if (parsed.ok) throw new Error("expected a syntax error");
  return { line: parsed.error.line, column: parsed.error.column };
}

describe("parse: precedence and associativity (spec 3)", () => {
  test.each([
    ["1 + 2 * 3", "(1 + (2 * 3))"],
    ["1 - 2 - 3", "((1 - 2) - 3)"],
    ["1 < 2 < 3", "((1 < 2) < 3)"],
    ["a || b && c", "(a || (b && c))"],
    ["a == b != c", "((a == b) != c)"],
    ["a < b == c < d", "((a < b) == (c < d))"],
    ["-a.b[0]", "(-a.b[0])"],
    ["!-x", "(!(-x))"],
    ["f(1)(2)", "f(1)(2)"],
    ["a % b / c * d", "(((a % b) / c) * d)"],
    ["(a + b) * c", "(group((a + b)) * c)"],
    ["a + b == c - d", "((a + b) == (c - d))"],
  ])("%s", (source, expected) => {
    expect(expressionOf(source)).toBe(expected);
  });

  test("a statement starting with { is a record literal expression", () => {
    expect(expressionOf("{a: 1, b: [2]}")).toBe("{a:1,b:[2]}");
  });
});

describe("parse: statements", () => {
  test("wait prefixes let and simple statements only", () => {
    const [letStatement, assignment, call] = parseStatements("wait let a = 1; wait a = 2; wait f();");
    expect([letStatement?.kind, assignment?.kind, call?.kind]).toEqual(["Let", "Assign", "Expression"]);
    expect([letStatement, assignment, call].every((statement) => statement !== undefined && "waits" in statement && statement.waits)).toBe(true);
  });

  test("else if chains nest as if statements", () => {
    const [statement] = parseStatements("if a { } else if b { } else { }");
    expect(statement?.kind === "If" && statement.elseBranch?.kind).toBe("If");
  });
});

describe("parse: grammar errors are at the first token that cannot continue (spec 3)", () => {
  test.each([
    ["a missing initializer", "let x = ;", 1, 9],
    ["end of input inside a block", "if true {", 1, 10],
    ["a missing semicolon is reported at the next token", "let a = 1\nlet b = 2;", 2, 1],
    ["a trailing comma in a call", "f(1,);", 1, 5],
    ["a trailing comma in an array", "[1, 2,];", 1, 7],
    ["a trailing comma in a record", "{a: 1,};", 1, 7],
    ["a keyword where an expression is expected", "let x = else;", 1, 9],
    ["a keyword as a field name", "a.let;", 1, 3],
    ["a stray closing brace", "}", 1, 1],
    ["wait before a compound statement", "wait if a { }", 1, 6],
    ["wait before wait", "wait wait f();", 1, 6],
    ["a second = in an assignment", "a = b = c;", 1, 7],
    ["a function parameter list with a trailing comma", "fn f(a,) { }", 1, 8],
    ["return without a semicolon at the end of input", "fn f() { return 1 }", 1, 19],
  ])("%s", (_label, source, line, column) => {
    expect(syntaxErrorOf(source)).toEqual({ line, column });
  });

  test("a lexical error before a grammar error wins, and a grammar error before a lexical error wins", () => {
    expect(syntaxErrorOf("let = 1 @")).toEqual({ line: 1, column: 5 });
    expect(syntaxErrorOf("let x = 1 + @")).toEqual({ line: 1, column: 13 });
    expect(syntaxErrorOf('let x = 1 +\n"unterminated')).toEqual({ line: 2, column: 1 });
  });
});
