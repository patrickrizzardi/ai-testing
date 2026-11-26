import { syntaxErrorAt } from "../errors";
import { KEYWORDS, type InvalidToken, type Token } from "./tokens";

const MAXIMUM_INTEGER_LITERAL = Number.MAX_SAFE_INTEGER;
const TWO_CHARACTER_PUNCTUATION: ReadonlySet<string> = new Set(["||", "&&", "==", "!=", "<=", ">="]);
const ONE_CHARACTER_PUNCTUATION: ReadonlySet<string> = new Set(["=", "<", ">", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", "{", "}", ",", ";", ":", "."]);
const ESCAPED_CHARACTERS: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

function isLetter(character: string): boolean {
  return (character >= "a" && character <= "z") || (character >= "A" && character <= "Z") || character === "_";
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * Splits `source` into tokens. The result always ends with an `end` token, or with an
 * `invalid` token at the first lexical error (nothing after it is read, so a grammar error
 * earlier in the source wins by position, as spec section 3 requires).
 * O(n) time, O(n) memory.
 */
export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;

  const column = (at: number): number => at - lineStart + 1;
  const invalidAt = (at: number, message: string): InvalidToken => {
    const position = { line, column: column(at) };
    return { kind: "invalid", ...position, error: syntaxErrorAt(position, message) };
  };

  // Reads the string literal whose opening quote is at `index`; returns an invalid token on error.
  const readString = (): Token => {
    const openingQuote = index;
    let value = "";
    let cursor = index + 1;
    for (;;) {
      const character = source[cursor];
      if (character === undefined || character === "\n") return invalidAt(openingQuote, "unterminated string literal");
      if (character === '"') break;
      if (character !== "\\") {
        value += character;
        cursor += 1;
        continue;
      }
      const escaped = source[cursor + 1];
      if (escaped === undefined) return invalidAt(openingQuote, "unterminated string literal");
      const decoded = Object.hasOwn(ESCAPED_CHARACTERS, escaped) ? ESCAPED_CHARACTERS[escaped] : undefined;
      if (decoded === undefined) return invalidAt(cursor, `unknown escape sequence \\${escaped}`);
      value += decoded;
      cursor += 2;
    }
    const token: Token = { kind: "string", value, line, column: column(openingQuote) };
    index = cursor + 1;
    return token;
  };

  while (index < source.length) {
    const character = source[index] as string;
    if (character === "\n") {
      line += 1;
      index += 1;
      lineStart = index;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (isLetter(character)) {
      const start = index;
      while (index < source.length && (isLetter(source[index] as string) || isDigit(source[index] as string))) index += 1;
      const text = source.slice(start, index);
      tokens.push({ kind: KEYWORDS.has(text) ? "keyword" : "identifier", text, line, column: column(start) });
      continue;
    }
    if (isDigit(character)) {
      const start = index;
      while (index < source.length && isDigit(source[index] as string)) index += 1;
      const value = Number(source.slice(start, index));
      if (value > MAXIMUM_INTEGER_LITERAL) {
        tokens.push(invalidAt(start, "integer literal is larger than 9007199254740991"));
        return tokens;
      }
      tokens.push({ kind: "integer", value, line, column: column(start) });
      continue;
    }
    if (character === '"') {
      const token = readString();
      tokens.push(token);
      if (token.kind === "invalid") return tokens;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (TWO_CHARACTER_PUNCTUATION.has(pair)) {
      tokens.push({ kind: "punctuation", text: pair, line, column: column(index) });
      index += 2;
      continue;
    }
    if (ONE_CHARACTER_PUNCTUATION.has(character)) {
      tokens.push({ kind: "punctuation", text: character, line, column: column(index) });
      index += 1;
      continue;
    }
    tokens.push(invalidAt(index, `unexpected character ${JSON.stringify(character)}`));
    return tokens;
  }
  tokens.push({ kind: "end", line, column: column(index) });
  return tokens;
}
