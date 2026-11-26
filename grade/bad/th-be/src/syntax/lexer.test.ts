import { describe, expect, test } from "bun:test";
import { lex } from "./lexer";
import type { Token } from "./tokens";

function describeTokens(source: string): string[] {
  return lex(source).map((token) => {
    switch (token.kind) {
      case "identifier":
      case "keyword":
      case "punctuation":
        return `${token.kind}:${token.text}@${token.line}:${token.column}`;
      case "integer":
      case "string":
        return `${token.kind}:${token.value}@${token.line}:${token.column}`;
      case "end":
        return `end@${token.line}:${token.column}`;
      case "invalid":
        return `invalid@${token.error.line}:${token.error.column}`;
    }
  });
}

function lastToken(source: string): Token {
  const tokens = lex(source);
  const last = tokens[tokens.length - 1];
  if (last === undefined) throw new Error("no tokens");
  return last;
}

describe("lex: tokens and positions", () => {
  // Bug: a two-character operator split in two, so `<=` lexes as `<` then `=`. Tier: High (parser).
  test("longest punctuation wins", () => {
    expect(describeTokens("a<=b==c!=d||e&&f")).toEqual([
      "identifier:a@1:1", "punctuation:<=@1:2", "identifier:b@1:4", "punctuation:==@1:5", "identifier:c@1:7",
      "punctuation:!=@1:8", "identifier:d@1:10", "punctuation:||@1:11", "identifier:e@1:13", "punctuation:&&@1:14", "identifier:f@1:16", "end@1:17",
    ]);
  });

  // Bug: columns counted in code points, so every error after an astral character is located wrong. Tier: High (parser).
  test("columns count UTF-16 code units, so a surrogate pair is two columns", () => {
    expect(describeTokens('"😀" x')).toEqual(["string:😀@1:1", "identifier:x@1:6", "end@1:7"]);
  });

  // Bug: CR or tab taken as a line break or a wider column, shifting every reported position. Tier: High (parser).
  test("a line starts after LF only; CR and tab are one column of whitespace", () => {
    expect(describeTokens("a\r\n\tb")).toEqual(["identifier:a@1:1", "identifier:b@2:2", "end@2:3"]);
  });

  // Bug: the end token placed before the last character or on the wrong line, misplacing every error at end of input. Tier: High (parser).
  test("the end token follows the last character, and is column 1 of the next line after a final LF", () => {
    expect(describeTokens("")).toEqual(["end@1:1"]);
    expect(describeTokens("x\n")).toEqual(["identifier:x@1:1", "end@2:1"]);
  });

  // Bug: a comment swallowing the next line, or not separating tokens. Tier: High (parser).
  test("a comment runs to the LF and separates tokens", () => {
    expect(describeTokens("a// c\nb")).toEqual(["identifier:a@1:1", "identifier:b@2:1", "end@2:2"]);
  });

  // Bug: a builtin name lexed as a keyword, or a keyword as an identifier. Tier: High (parser).
  test("keywords are not identifiers; builtin names are identifiers", () => {
    expect(describeTokens("let print nil")).toEqual(["keyword:let@1:1", "identifier:print@1:5", "keyword:nil@1:11", "end@1:14"]);
  });

  // Bug: a leading-zero literal or the largest safe integer rejected or misread. Tier: High (parser).
  test("integers keep leading zeros out of their value; the largest safe integer is accepted", () => {
    expect(describeTokens("007 9007199254740991")).toEqual(["integer:7@1:1", "integer:9007199254740991@1:5", "end@1:21"]);
  });

  // Bug: an escape decoded twice or out of order, changing every string that holds a backslash. Tier: High (parser).
  test("string escapes are decoded left to right", () => {
    const token = lex('"a\\n\\t\\r\\"\\\\n"')[0];
    expect(token).toMatchObject({ kind: "string", value: 'a\n\t\r"\\n' });
  });
});

describe("lex: lexical errors end the token stream", () => {
  // Bug: a lexical error reported at the wrong token (spec 2 table), or a bad literal accepted. Tier: High (parser).
  test.each([
    ["a character that starts no token", "let x = 1 @ 2;", 1, 11],
    ["a lone ampersand", "a & b", 1, 3],
    ["a lone bar", "a | b", 1, 3],
    ["a non-ASCII letter", "let é = 1;", 1, 5],
    ["an integer above the safe maximum", "let x = 9007199254740992;", 1, 9],
    ["an unterminated string is located at its opening quote", 'print("abc);', 1, 7],
    ["a string cut by LF", 'x = "ab\ncd";', 1, 5],
    ["an escaped quote does not close the string", 'x = "ab\\"', 1, 5],
    ["an unknown escape is located at the backslash", 'x = "ab\\qcd";', 1, 8],
    ["a backslash before the end of the source leaves the string unterminated", 'x = "ab\\', 1, 5],
    ["the position counts from the start of its line", 'a;\n  b = "x\\z";', 2, 9],
  ])("%s", (_label, source, line, column) => {
    const last = lastToken(source);
    expect(last.kind).toBe("invalid");
    expect(last).toMatchObject({ error: { kind: "SyntaxError", line, column } });
  });

  // Bug: lexing on past the first error, so a later lexical error is reported instead of it. Tier: High (parser).
  test("nothing after the first lexical error is read", () => {
    expect(describeTokens("a @ b @ c")).toEqual(["identifier:a@1:1", "invalid@1:3"]);
  });
});
