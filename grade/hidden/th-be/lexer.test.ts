// Spec section 2 (lexical structure). Each test names the rule it checks; the
// comment above it names the bug it catches. Tier: High (parser/validator-class
// logic), so the edge cases at each boundary are the contract.
import { describe, expect, test } from "bun:test";
import { exec, expectOk, expectSyntaxErrorAt } from "./harness.ts";

async function printed(source: string): Promise<string[]> {
  return (await expectOk(source)).output;
}

describe("lexer: literals", () => {
  // Catches: leading zeros rejected or read as octal.
  test("INT allows leading zeros: 007 is 7", async () => {
    expect(await printed("print(007); print(0000); print(010);")).toEqual(["7", "0", "10"]);
  });

  // Catches: off-by-one in the 2^53-1 literal limit.
  test("INT at the limit 9007199254740991 is accepted, with or without leading zeros", async () => {
    expect(await printed("print(9007199254740991); print(0009007199254740991);")).toEqual([
      "9007199254740991",
      "9007199254740991",
    ]);
  });

  // Catches: float parsing that silently rounds big literals (2^53 + 1 parses as 2^53).
  test.each([
    ["2^53", "let n = ⟦9007199254740992;"],
    ["2^53 + 1 (not representable as a double)", "let n = ⟦9007199254740993;"],
    ["20 digits", "print(⟦99999999999999999999);"],
    ["leading zeros over the limit", "print(⟦0009007199254740992);"],
    ["second operand", "print(1 + ⟦18014398509481984);"],
  ])("INT above 9007199254740991 is a lexical error at its first digit: %s", async (_label, template) => {
    await expectSyntaxErrorAt(template);
  });

  // Catches: -5 treated as one literal, or unary minus on the limit literal failing.
  test("there is no negative literal: -5 is unary minus applied to 5, and -9007199254740991 is valid", async () => {
    expect(await printed("print(-5); print(- 5); print(-9007199254740991); print(5 - -3); print(5--3);")).toEqual([
      "-5",
      "-5",
      "-9007199254740991",
      "8",
      "8",
    ]);
  });

  // Catches: each escape mapped wrongly, or escapes left undecoded.
  test("STRING decodes the five escapes", async () => {
    const outcome = await expectOk('print("a\\nb"); print("a\\tb"); print("a\\rb"); print("q\\"q"); print("b\\\\s");');
    expect(outcome.output).toEqual(["a\nb", "a\tb", "a\rb", 'q"q', "b\\s"]);
  });

  // Catches: sequential replace of escapes (\\n decoded as backslash + LF).
  test("STRING escapes are decoded left to right: \\\\n is a backslash then n", async () => {
    expect(await printed('print("\\\\n"); print(len("\\\\n"));')).toEqual(["\\n", "2"]);
  });

  // Catches: rejecting raw CR/tab/non-ASCII inside strings (stringChar is anything except quote, backslash, LF).
  test("STRING may contain raw tab, raw CR, comment markers and non-ASCII code units", async () => {
    const outcome = await expectOk('print("a\tb"); print("a\rb"); print("x // y"); print("é😀"); print(len("é😀"));');
    expect(outcome.output).toEqual(["a\tb", "a\rb", "x // y", "é😀", "3"]);
  });

  // Catches: an empty string literal failing to lex.
  test("STRING may be empty", async () => {
    expect(await printed('print(len("")); print("" == "");')).toEqual(["0", "true"]);
  });
});

describe("lexer: identifiers and keywords", () => {
  // Catches: keyword matched by prefix (letx read as `let x`), case-insensitive keywords.
  test("identifiers that start like a keyword are identifiers; keywords are case-sensitive", async () => {
    const source = [
      "let letx = 1; let iffy = 2; let nilx = 3; let truest = 4; let in_ = 5; let waiting = 6;",
      "let Let = 7; let NIL = 8; let True = 9; let fnx = 10; let returns = 11; let _ = 12; let a_b9 = 13; let Z = 14;",
      "print(letx + iffy + nilx + truest + in_ + waiting + Let + NIL + True + fnx + returns + _ + a_b9 + Z);",
    ].join("\n");
    expect(await printed(source)).toEqual(["105"]);
  });

  // Catches: a keyword accepted as an identifier.
  test.each([
    ["let", "let ⟦let = 1;"],
    ["if", "let ⟦if = 1;"],
    ["else", "let ⟦else = 1;"],
    ["while", "let ⟦while = 1;"],
    ["for", "let ⟦for = 1;"],
    ["in", "let ⟦in = 1;"],
    ["fn", "let ⟦fn = 1;"],
    ["return", "let ⟦return = 1;"],
    ["wait", "let ⟦wait = 1;"],
    ["true", "let ⟦true = 1;"],
    ["false", "let ⟦false = 1;"],
    ["nil", "let ⟦nil = 1;"],
  ])("keyword %s cannot be a name", async (_keyword, template) => {
    await expectSyntaxErrorAt(template);
  });

  // Catches: builtin names reserved as keywords.
  test("builtin names are ordinary identifiers: they can be copied, shadowed and redeclared as fn", async () => {
    const source = [
      "let alias = print;",
      "alias(1);",
      "let len = 5;",
      "print(len);",
      "fn keys() { return 7; }",
      "print(keys());",
      "fn sleep(x) { return x; }",
      "print(sleep(3));",
    ].join("\n");
    expect(await printed(source)).toEqual(["1", "5", "7", "3"]);
  });

  // Catches: digits glued to letters lexed as one token (a lexical error) instead of INT then IDENT (a grammar error at the IDENT).
  test("1abc is INT 1 then IDENT abc: a grammar error at abc, not a lexical error", async () => {
    await expectSyntaxErrorAt("let x = 1⟦abc;");
  });
});

describe("lexer: maximal munch", () => {
  // Catches: two-character operators split into two tokens.
  test("<= >= == != && || are single tokens", async () => {
    const source = "print(1 <= 2); print(2 >= 3); print(1 == 1); print(1 != 1); print(true && false); print(false || true);";
    expect(await printed(source)).toEqual(["true", "false", "true", "false", "false", "true"]);
  });

  // Catches: the longest match not taken: "a<=b" lexed as "<" "=".
  test("operators without spaces take the longest token", async () => {
    expect(await printed("let a = 1; let b = 2; print(a<=b); print(a>=b); print(a!=b); print(a==b);")).toEqual([
      "true",
      "false",
      "true",
      "false",
    ]);
  });

  // Catches: '! =' accepted as '!='.
  test("a space splits a two-character operator", async () => {
    await expectSyntaxErrorAt("print(1 ⟦! = 2);");
    await expectSyntaxErrorAt("print(1 ⟦= = 2);");
    await expectSyntaxErrorAt("print(1 < ⟦= 2);");
  });

  // Catches: '&&&' read as '&&' plus a swallowed '&'.
  test("&&& is && then a lone & (error at the third character); ||| likewise", async () => {
    await expectSyntaxErrorAt("print(true &&⟦& true);");
    await expectSyntaxErrorAt("print(true ||⟦| true);");
  });

  // Catches: lone & or | treated as bitwise/unknown tokens.
  test.each([
    ["lone &", "let a = true ⟦& false;"],
    ["lone |", "let a = true ⟦| false;"],
    ["& at the end of the source", "let a = true ⟦&"],
    ["| then &", "let a = true ⟦|& false;"],
  ])("%s is a lexical error at that character", async (_label, template) => {
    await expectSyntaxErrorAt(template);
  });

  // Catches: tokens that stick together without whitespace being merged.
  test("punctuation needs no whitespace", async () => {
    expect(await printed("let r={a:1,b:[2,3]};print(r.b[1]+r.a);")).toEqual(["4"]);
  });
});

describe("lexer: whitespace, comments, characters outside the grammar", () => {
  // Catches: a comment that swallows the next line, or a comment not ended by LF.
  test("a comment runs to the next LF and no further", async () => {
    expect(await printed("print(1); // print(2);\nprint(3); // trailing")).toEqual(["1", "3"]);
  });

  // Catches: // inside a comment of only slashes, / alone treated as a comment.
  test("a single / is division; // starts a comment", async () => {
    expect(await printed("print(8 / 2); print(8 /2); print(9/3); //// 7")).toEqual(["4", "4", "3"]);
  });

  // Catches: comments rejected at end of source or containing quotes/unknown characters.
  test("a comment may contain quotes and characters that are errors elsewhere; it may end the source", async () => {
    expect(await printed('print(1); // "unclosed @ # é \\q\n// last line, no LF')).toEqual(["1"]);
  });

  // Catches: // inside a string treated as a comment.
  test("// inside a string is part of the string", async () => {
    expect(await printed('print("a//b"); // real comment')).toEqual(["a//b"]);
  });

  // Catches: empty or comment-only programs rejected.
  test.each([
    ["empty source", ""],
    ["only whitespace", " \t\r\n  \n"],
    ["only a comment", "// nothing"],
    ["comment ending in LF", "// nothing\n"],
  ])("a program with no statements is valid: %s", async (_label, source) => {
    const outcome = await exec(source);
    expect(outcome).toMatchObject({ output: [], error: null, heap: { allocs: 0, frees: 0 } });
  });

  // Catches: CR rejected as an unknown character, or CRLF line counting wrong.
  test("CR is whitespace: CRLF sources work and the line counts only LF", async () => {
    await expectSyntaxErrorAt("print(1);\r\nprint(2);\r\nlet x = ⟦;");
  });

  // Catches: a bare CR starting a new line.
  test("a bare CR does not start a line and counts as one column", async () => {
    await expectSyntaxErrorAt("print(1);\r⟦@");
  });

  // Catches: a tab counting as more than one column.
  test("a tab is one column", async () => {
    await expectSyntaxErrorAt("\t\t⟦@");
    await expectSyntaxErrorAt("let\tx\t=\t⟦;");
  });

  // Catches: columns counted in code points or bytes instead of UTF-16 code units.
  test("columns count UTF-16 code units: an astral character before the error takes two", async () => {
    await expectSyntaxErrorAt('print("😀😀"); ⟦@');
    await expectSyntaxErrorAt('// 😀 é\n"é😀" + ⟦@');
  });

  // Catches: unknown characters silently skipped.
  test.each([
    ["@", "let a = ⟦@;"],
    ["#", "let a = ⟦#;"],
    ["$", "let a = ⟦$;"],
    ["?", "let a = ⟦?;"],
    ["single quote", "let a = ⟦'x';"],
    ["backtick", "let a = ⟦`x`;"],
    ["tilde", "let a = ⟦~1;"],
    ["caret", "let a = 1 ⟦^ 2;"],
    ["backslash outside a string", "let a = ⟦\;"],
    ["non-ASCII letter", "let ⟦é = 1;"],
    ["non-breaking space", "let a =⟦\u00a01;"],
    ["form feed", "let a = ⟦\f1;"],
    ["vertical tab", "let a = ⟦\v1;"],
    ["NUL", "let a = ⟦\u00001;"],
    ["astral character", "let a = ⟦😀;"],
    ["byte order mark", "⟦\ufefflet a = 1;"],
  ])("a character that starts no token is a lexical error at it: %s", async (_label, template) => {
    await expectSyntaxErrorAt(template);
  });

  // Catches: the lexical error reported after the first one in source order.
  test("with two lexical errors the first in the source is reported", async () => {
    await expectSyntaxErrorAt("let a = ⟦@ + #;");
    await expectSyntaxErrorAt('let a = "ok" + ⟦#;\nlet b = "x\\q";');
  });
});

describe("lexer: string errors", () => {
  // Catches: unterminated string located at the end/LF instead of the opening quote.
  test.each([
    ["before the closing paren", 'print(⟦"abc);'],
    ["at the end of the source", 'let s = ⟦"abc'],
    ["ended by LF", 'let s = ⟦"abc\nlet t = 1;'],
    ["only the opening quote", "⟦\""],
    ["on a later line", 'let a = 1;\nlet b = 2;\n  print(⟦"x);'],
    ["escaped quote does not close it", 'let s = ⟦"abc\\"'],
    ["a comment marker inside does not matter", 'let s = ⟦"a // b'],
  ])("an unclosed string is an error at its opening quote: %s", async (_label, template) => {
    await expectSyntaxErrorAt(template);
  });

  // Catches: unknown escapes passed through or located at the character after the backslash.
  test.each([
    ["\\q", 'print("a⟦\\qb");'],
    ["\\x41", 'print("⟦\\x41");'],
    ["\\0", 'print("⟦\\0");'],
    ["\\'", "print(\"⟦\\'\");"],
    ["\\u0041", 'print("⟦\\u0041");'],
    ["\\ followed by a space", 'print("a⟦\\ b");'],
    ["\\N (upper case)", 'print("⟦\\N");'],
    ["second backslash after a valid escape pair", 'print("\\\\⟦\\q");'],
    ["after a valid escape", 'print("\\n⟦\\q");'],
  ])("a backslash followed by anything but n t r \" \\ is an error at the backslash: %s", async (_label, template) => {
    await expectSyntaxErrorAt(template);
  });

  // Catches: lexical error positions measured from the string start for multi-line sources.
  test("bad escape position on a later line counts columns from that line", async () => {
    await expectSyntaxErrorAt('let a = 1;\n\n    print("ab⟦\\z");');
  });
});

describe("lexer: lexical errors compete with grammar and static errors by position", () => {
  // Catches: lexing the whole source first and reporting its error even when a grammar error comes earlier.
  test("a grammar error before a lexical error is reported", async () => {
    await expectSyntaxErrorAt("let x = ⟦; @");
    await expectSyntaxErrorAt('let ⟦5 = 1; "unclosed');
    await expectSyntaxErrorAt("print(1 ⟦2 3 @");
  });

  // Catches: parsing past a lexical error, reporting a later grammar error.
  test("a lexical error before a grammar error is reported", async () => {
    await expectSyntaxErrorAt("let ⟦@ = ;");
    await expectSyntaxErrorAt('print(⟦"abc);\nlet = ;');
    await expectSyntaxErrorAt("let x = 1 ⟦@");
  });

  // Catches: static errors (section 4) reported although the source does not lex/parse.
  test("static errors are reported only for a source with no lexical or grammar error", async () => {
    await expectSyntaxErrorAt("let a = 1; let a = 2; ⟦@");
    await expectSyntaxErrorAt("return 1; let ⟦= 2;");
    await expectSyntaxErrorAt("1 = 2; print(⟦9007199254740992);");
  });
});
