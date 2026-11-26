// Spec section 3 (syntax, precedence, associativity, grammar-error positions).
// Tier: High (parser). Tree shape is observed through values and through the
// position of the operator that fails first, never through internals.
import { describe, expect, test } from "bun:test";
import { exec, expectOk, expectRuntimeErrorAt, expectSyntaxErrorAt } from "./harness.ts";

async function value(expression: string, prelude = ""): Promise<string> {
  const outcome = await expectOk(`${prelude}print(${expression});`);
  expect(outcome.output).toHaveLength(1);
  return outcome.output[0] as string;
}

describe("parser: precedence and associativity (table in section 3)", () => {
  // Each row separates one adjacent pair of levels, or one associativity, from the wrong grouping.
  const table: [string, string, string][] = [
    ["* over +", "1 + 2 * 3", "7"],
    ["* over + (right operand)", "2 * 3 + 4", "10"],
    ["parentheses override", "(1 + 2) * 3", "9"],
    ["+ - left assoc", "10 - 3 - 2", "5"],
    ["+ - mixed left assoc", "10 - 3 + 2", "9"],
    ["/ left assoc", "100 / 10 / 5", "2"],
    ["* / left assoc", "8 / 2 * 4", "16"],
    ["% * left assoc", "7 % 4 * 2", "6"],
    ["/ % left assoc", "100 / 5 % 3", "2"],
    ["% over +", "2 + 3 % 2", "3"],
    ["both sides of a chain", "20 - 2 * 3 - 4", "10"],
    ["unary over binary +", "-1 + 2", "1"],
    ["unary over binary -", "-2 - 3", "-5"],
    ["unary operand of *", "1 + -2 * 3", "-5"],
    ["unary after binary operator", "2 * -3 + 1", "-5"],
    ["double unary minus (right assoc)", "- -4", "4"],
    ["double not", "!!true", "true"],
    ["not over &&", "!false && true", "true"],
    ["+ over <", "1 + 2 < 4", "true"],
    ["* over >=", "1 + 2 * 3 >= 7", "true"],
    ["+ over ==", "1 + 1 == 2", "true"],
    ["relational over equality (left)", "1 < 2 == true", "true"],
    ["relational over equality (right)", "true == 1 < 2", "true"],
    ["equality left assoc", "1 == 1 != false", "true"],
    ["equality chain compares the first result", "1 == 1 == 1", "false"],
    ["!= chain", "1 != 2 != true", "false"],
    ["== over &&", "false == false && false", "false"],
    ["relational over &&", "1 < 2 && 2 < 3", "true"],
    ["&& over || (|| first)", "true || true && false", "true"],
    ["&& over || (&& first)", "false && true || true", "true"],
    ["|| && with parentheses", "(false || true) && false", "false"],
    ["&& left assoc", "true && true && false", "false"],
    ["|| left assoc", "false || false || true", "true"],
    ["string + string chain", '"a" + "b" + "c"', "abc"],
    ["string comparison over &&", '"a" < "b" && "b" < "c"', "true"],
  ];
  for (const [rule, expression, expected] of table) {
    // Catches: operator table wired with a wrong level or the wrong associativity.
    test(`${rule}: ${expression}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }

  // Catches: unary applied to the whole postfix chain's prefix instead of its result.
  test("postfix binds tighter than unary: -a.b[0] is -((a.b)[0])", async () => {
    expect(await value("-a.b[0]", "let a = {b: [5]};\n")).toBe("-5");
    expect(await value("!r.f()", "let r = {f: fn_false};\nfn fn_false() { return false; }\n")).toBe("true");
  });

  // Catches: call/index/field applied right to left or only once.
  test("postfix operators apply left to right: f(1)(2), a[0][1], a.b.c, a.b[0].c, g().x, fs[0](3), r.f(4)", async () => {
    const prelude = [
      "fn adder(x) { fn add(y) { return x + y; } return add; }",
      "let a = [[10, 11], [12]];",
      "let r = {b: {c: 7}, d: [{c: 8}], f: adder};",
      "fn g() { return {x: 9}; }",
      "let fs = [adder];",
      "",
    ].join("\n");
    expect(await value("adder(1)(2)", prelude)).toBe("3");
    expect(await value("a[0][1]", prelude)).toBe("11");
    expect(await value("r.b.c", prelude)).toBe("7");
    expect(await value("r.d[0].c", prelude)).toBe("8");
    expect(await value("g().x", prelude)).toBe("9");
    expect(await value("fs[0](3)(4)", prelude)).toBe("7");
    expect(await value("r.f(5)(6)", prelude)).toBe("11");
  });

  // Catches: literals not accepted as postfix bases.
  test("postfix applies to array, record, string-free primaries and parenthesized expressions", async () => {
    expect(await value("[1, 2, 3][1]")).toBe("2");
    expect(await value("{a: 5}.a")).toBe("5");
    expect(await value("([4, 5])[1]")).toBe("5");
    expect(await value("{a: [1, {b: 6}]}.a[1].b")).toBe("6");
  });

  // Catches: the tree shape checked wrongly: the operator whose operands are evaluated and checked first is the innermost one.
  test.each([
    ["1 < 2 < 3 is (1 < 2) < 3: error at the second <", "print(1 < 2 ⟦< 3);"],
    ["3 > 2 > 1 is (3 > 2) > 1: error at the second >", "print(3 > 2 ⟦> 1);"],
    ["1 <= 2 >= 0 is (1 <= 2) >= 0", "print(1 <= 2 ⟦>= 0);"],
    ["1 + 2 * \"a\": * binds first", 'print(1 + 2 ⟦* "a");'],
    ["\"a\" * 2 + 1: * binds first", 'print("a" ⟦* 2 + 1);'],
    ["1 + 2 < \"a\": < is the failing operator", 'print(1 + 2 ⟦< "a");'],
    ["!5 == 5 is (!5) == 5: error at !", "print(⟦!5 == 5);"],
    ["-\"a\" + 1: unary first", 'print(⟦-"a" + 1);'],
    ["-!true: error at the outer -", "print(⟦-!true);"],
    ["!-1: error at the outer !", "print(⟦!-1);"],
    ["true && 1 || 2: && binds first", "print(true ⟦&& 1 || 2);"],
    ["1 || 2 && 3: error at ||", "print(1 ⟦|| 2 && 3);"],
    ["false || 1 && 2: && is the right operand of ||, so && fails first", "print(false || 1 ⟦&& 2);"],
    ["a call result is the unary operand: -f() with f returning a string", 'fn f() { return "s"; }\nprint(⟦-f());'],
  ])("shape: %s", async (_label, template) => {
    await expectRuntimeErrorAt(template);
  });
});

describe("parser: valid programs", () => {
  // Catches: the accepted statement forms of section 3 each rejected or mis-parsed.
  test("every statement form parses: let, assign, expr, if/else if/else, while, for, fn, return, wait", async () => {
    const source = [
      "fn add(a, b) { return a + b; }",
      "fn none() { return; }",
      "fn nothing() { }",
      "let total = 0;",
      "let items = [1, 2, 3];",
      "for item in items { total = total + item; }",
      "let n = 0;",
      "while n < 3 { n = n + 1; }",
      "if n == 0 { print(\"zero\"); } else if n == 3 { print(\"three\"); } else { print(\"other\"); }",
      "if false { } else { }",
      "wait let w = add(1, 2);",
      "wait add(1, 2);",
      "wait total = total + 1;",
      "items[0] = 9;",
      "let r = {x: 1};",
      "r.y = 2;",
      "print(total);",
      "print(items);",
      "print(w);",
      "print(none());",
      "print(nothing());",
      "print(r);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["three", "7", "[9, 2, 3]", "3", "nil", "nil", "{x: 1, y: 2}"]);
  });

  // Catches: `{` at statement start parsed as a block, so a record statement fails.
  test("a statement starting with { is an expression statement with a record literal", async () => {
    const outcome = await expectOk("{a: 1};\n{};\n{a: 1, b: [2]}.a = 3;\nprint(1);");
    expect(outcome.output).toEqual(["1"]);
    expect(outcome.heap).toEqual({ allocs: 4, frees: 4 });
  });

  // Catches: nested functions and blocks without the statement terminator rules.
  test("compound statements take no semicolon; nested blocks and functions nest", async () => {
    const source = [
      "fn outer() {",
      "  fn inner() { if true { while false { } for q in [] { } } return 5; }",
      "  return inner();",
      "}",
      "print(outer());",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["5"]);
  });

  // Catches: the optional parts of lists (empty args, empty literals) rejected.
  test("empty argument list, array literal, record literal and parameter list are valid", async () => {
    expect((await expectOk("fn f() { return [[], {}]; } print(f());")).output).toEqual(["[[], {}]"]);
  });

  // Catches: parenthesized postfix targets rejected or mis-validated.
  test("(a)[0] = 1 and f(x).y = 1 are valid assignment targets", async () => {
    const source = "let a = [0]; (a)[0] = 5; fn pick(r) { return r; } let r = {y: 0}; pick(r).y = 6; print(a); print(r);";
    expect((await expectOk(source)).output).toEqual(["[5]", "{y: 6}"]);
  });
});

describe("parser: grammar errors are at the first token that cannot continue (section 3)", () => {
  // Each row: a token that cannot validly continue what precedes it.
  const table: [string, string][] = [
    ["expression missing after =", "let x = ⟦;"],
    ["statement ends at EOF in a block", "if true {⟦"],
    ["missing ; at EOF (EOF column after the last character)", "let x = 1⟦"],
    ["missing ; at EOF after a trailing LF is on the next line", "let x = 1\n⟦"],
    ["missing ; before the next statement", "let x = 1\n⟦let y = 2;"],
    ["name missing after let", "let ⟦5 = 1;"],
    ["= missing in let", "let x ⟦1;"],
    ["no second = in a statement: a = b = c", "let a = 0; let b = 0; a = b ⟦= 1;"],
    ["no assignment inside let", "let a = 0; let b = a ⟦= 1;"],
    ["stray } at top level", "let a = 1;\n⟦}"],
    ["stray else", "⟦else { }"],
    ["else followed by neither if nor block", "if true { } else ⟦print(1);"],
    ["; after a compound statement", "if true { }⟦;"],
    ["; after a fn declaration", "fn f() { }⟦;"],
    ["lone ;", "⟦;"],
    ["= at statement start", "⟦= 1;"],
    ["while without a block", "while true ⟦print(1);"],
    ["if without a block", "if true ⟦return 1;"],
    ["for with a non-in keyword word", "for x ⟦of items { }"],
    ["for without a loop name", "for ⟦1 in items { }"],
    ["for with a keyword as loop name", "for ⟦nil in items { }"],
    ["for missing the block at EOF", "for x in items⟦"],
    ["fn without a name", "fn ⟦(a) { }"],
    ["fn with trailing comma in params", "fn f(a, ⟦) { }"],
    ["fn with leading comma in params", "fn f(⟦, a) { }"],
    ["fn with a keyword parameter", "fn f(⟦true) { }"],
    ["fn with a literal parameter", "fn f(⟦1) { }"],
    ["fn missing its block", "fn f(a) ⟦let x = 1;"],
    ["return without ;", "fn f() { return 1 ⟦}"],
    ["trailing comma in call arguments", "f(1,⟦);"],
    ["missing comma in call arguments", "f(1 ⟦2);"],
    ["trailing comma in array literal", "let a = [1, 2,⟦];"],
    ["trailing comma in record literal", "let r = {a: 1,⟦};"],
    ["missing : in record literal", "let r = {a ⟦1};"],
    ["string as a record field name", 'let r = {⟦"a": 1};'],
    ["keyword as a record field name", "let r = {⟦if: 1};"],
    ["number as a record field name", "let r = {⟦1: 1};"],
    ["a block-looking statement is a record literal: print is the field name, ( cannot continue", "{ print⟦(1); }"],
    ["record literal statement needs ;", "{a: 1}⟦"],
    ["unclosed paren", "let a = (1 + 2⟦;"],
    ["unclosed bracket", "let a = b[1⟦;"],
    ["unclosed array literal at EOF", "let a = [1, 2⟦"],
    ["missing operand", "let a = 1 +⟦;"],
    ["operand expected after *", "let a = 1 * ⟦* 2;"],
    ["empty parentheses", "let a = ⟦);"],
    ["field name missing", "a.⟦;"],
    ["field name is a number", "a.⟦1;"],
    ["field name is a keyword", "a.⟦nil;"],
    ["field name is a keyword (let)", "a.⟦let = 1;"],
    ["empty index", "a[⟦];"],
    ["two expressions in a row", "let x = 1 ⟦2;"],
    ["call without callee start: )", "⟦);"],
    ["wait before if", "wait ⟦if true { }"],
    ["wait before while", "wait ⟦while true { }"],
    ["wait before for", "wait ⟦for x in a { }"],
    ["wait before fn", "wait ⟦fn f() { }"],
    ["wait before return", "fn f() { wait ⟦return 1; }"],
    ["wait before wait", "wait ⟦wait f();"],
    ["wait before ;", "wait ⟦;"],
    ["wait at EOF", "wait⟦"],
    ["a keyword as an expression", "let a = ⟦else;"],
    ["let at the start of an expression", "let a = ⟦let;"],
    ["missing block close at EOF with LF", "while true {\n  print(1);\n⟦"],
    ["missing ) in fn header at {", "fn f(a ⟦{ }"],
    ["unexpected ] after expression", "let a = 1 ⟦];"],
    ["a { after else if is a record literal condition, so the block is missing at EOF", "if true { } else if { }⟦"],
  ];
  for (const [rule, template] of table) {
    // Catches: error reported at the wrong token (previous token, statement start, or EOF) or accepted as valid.
    test(rule, async () => {
      await expectSyntaxErrorAt(template);
    });
  }

  // Catches: a grammar error reported after a static error that sits earlier in the source.
  test("a grammar error wins over a static error even when the static error is earlier", async () => {
    await expectSyntaxErrorAt("let a = 1; let a = 2; a + ⟦;");
    await expectSyntaxErrorAt("return 1; 1 = 2; let ⟦= 3;");
  });

  // Catches: EOF position for a source of only whitespace/comments after the failing point.
  test("EOF position is just after the last character, comments included", async () => {
    await expectSyntaxErrorAt("print(1) // no semicolon⟦");
    await expectSyntaxErrorAt("print(1) // no semicolon\n⟦");
    await expectSyntaxErrorAt("if true {\r\n  print(1);\r\n⟦");
  });

  // Catches: spec example 12.4 grammar rows reported with message-less or wrong-kind errors.
  test("the error object has kind SyntaxError, a non-empty message and no output", async () => {
    const outcome = await exec("let x = ;");
    expect(outcome.error?.kind).toBe("SyntaxError");
    expect(outcome.output).toEqual([]);
    expect(outcome.heap).toEqual({ allocs: 0, frees: 0 });
  });
});
