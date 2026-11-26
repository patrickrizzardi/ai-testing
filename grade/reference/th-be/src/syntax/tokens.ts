import type { RippleError } from "../errors";

type TokenPlace = { readonly line: number; readonly column: number };

export const KEYWORDS: ReadonlySet<string> = new Set(["let", "if", "else", "while", "for", "in", "fn", "return", "wait", "true", "false", "nil"]);

export type IdentifierToken = TokenPlace & { readonly kind: "identifier"; readonly text: string };
export type KeywordToken = TokenPlace & { readonly kind: "keyword"; readonly text: string };
export type IntegerToken = TokenPlace & { readonly kind: "integer"; readonly value: number };
export type StringToken = TokenPlace & { readonly kind: "string"; readonly value: string };
export type PunctuationToken = TokenPlace & { readonly kind: "punctuation"; readonly text: string };
export type EndToken = TokenPlace & { readonly kind: "end" };
/** Stands where the lexer found a lexical error; the parser reports `error` when it reaches this token. */
export type InvalidToken = TokenPlace & { readonly kind: "invalid"; readonly error: RippleError };

export type Token = IdentifierToken | KeywordToken | IntegerToken | StringToken | PunctuationToken | EndToken | InvalidToken;
