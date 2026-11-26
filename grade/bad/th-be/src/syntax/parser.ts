import { fail, succeed, syntaxErrorAt, type Result, type RippleError } from "../errors";
import { requireElement } from "../invariants";
import type {
  Block,
  Expression,
  ExpressionStatement,
  FunctionDeclaration,
  IfStatement,
  LetStatement,
  Program,
  RecordField,
  Statement,
  AssignStatement,
  BinaryOperator,
  UnaryOperator,
} from "./ast";
import type { IdentifierToken, PunctuationToken, Token } from "./tokens";

/** Binary operator levels from lowest to highest binding; every level is left associative. */
const BINARY_LEVELS: readonly (readonly string[])[] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

/** Thrown inside the parser only; `parse` turns it into a `Result`. */
class GrammarFailure extends Error {
  constructor(readonly error: RippleError) {
    super(error.message);
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case "end":
      return "end of input";
    case "identifier":
    case "keyword":
    case "punctuation":
      return `'${token.text}'`;
    case "integer":
      return `integer ${token.value}`;
    case "string":
      return "string literal";
    case "invalid":
      return token.error.message;
  }
}

/** Recursive descent over the grammar of spec section 3; one token of lookahead. */
class Parser {
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private get current(): Token {
    return requireElement(this.tokens, this.position, "token: the stream must end with an end or invalid token");
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== "end" && token.kind !== "invalid") this.position += 1;
    return token;
  }

  /** The first token that cannot continue the program is the error; a lexical error token reports itself. */
  private reject(token: Token): never {
    if (token.kind === "invalid") throw new GrammarFailure(token.error);
    throw new GrammarFailure(syntaxErrorAt(token, `unexpected ${describe(token)}`));
  }

  private isPunctuation(text: string): boolean {
    const token = this.current;
    return token.kind === "punctuation" && token.text === text;
  }

  private isKeyword(text: string): boolean {
    const token = this.current;
    return token.kind === "keyword" && token.text === text;
  }

  private expectPunctuation(text: string): PunctuationToken {
    const token = this.current;
    if (token.kind !== "punctuation" || token.text !== text) this.reject(token);
    this.advance();
    return token;
  }

  private expectKeyword(text: string): Token {
    const token = this.current;
    if (token.kind !== "keyword" || token.text !== text) this.reject(token);
    return this.advance();
  }

  private expectIdentifier(): IdentifierToken {
    const token = this.current;
    if (token.kind !== "identifier") this.reject(token);
    this.advance();
    return token;
  }

  parseProgram(): Program {
    const statements: Statement[] = [];
    while (this.current.kind !== "end") statements.push(this.parseStatement());
    return { kind: "Program", statements };
  }

  private parseBlock(): Block {
    this.expectPunctuation("{");
    const statements: Statement[] = [];
    while (!this.isPunctuation("}")) statements.push(this.parseStatement());
    this.advance();
    return { kind: "Block", statements };
  }

  private parseStatement(): Statement {
    const token = this.current;
    if (token.kind !== "keyword") return this.parseSimpleStatement(false);
    switch (token.text) {
      case "wait":
        this.advance();
        return this.parseWaitable();
      case "let":
        return this.parseLetStatement(false);
      case "if":
        return this.parseIfStatement();
      case "while": {
        this.advance();
        const condition = this.parseExpression();
        return { kind: "While", condition, body: this.parseBlock() };
      }
      case "for": {
        this.advance();
        const variableToken = this.expectIdentifier();
        this.expectKeyword("in");
        const iterable = this.parseExpression();
        return { kind: "For", variableToken, iterable, body: this.parseBlock() };
      }
      case "fn":
        return this.parseFunctionDeclaration();
      case "return": {
        this.advance();
        const value = this.isPunctuation(";") ? null : this.parseExpression();
        this.expectPunctuation(";");
        return { kind: "Return", keyword: token, value };
      }
      default:
        return this.parseSimpleStatement(false);
    }
  }

  /** After `wait`: only a `let` or a simple statement may follow. */
  private parseWaitable(): LetStatement | ExpressionStatement | AssignStatement {
    if (this.isKeyword("let")) return this.parseLetStatement(true);
    const token = this.current;
    if (token.kind === "keyword" && ["wait", "if", "while", "for", "fn", "return"].includes(token.text)) this.reject(token);
    return this.parseSimpleStatement(true);
  }

  private parseLetStatement(waits: boolean): LetStatement {
    this.expectKeyword("let");
    const nameToken = this.expectIdentifier();
    this.expectPunctuation("=");
    const initializer = this.parseExpression();
    this.expectPunctuation(";");
    return { kind: "Let", waits, name: nameToken.text, nameToken, initializer };
  }

  private parseSimpleStatement(waits: boolean): ExpressionStatement | AssignStatement {
    const expression = this.parseExpression();
    if (!this.isPunctuation("=")) {
      this.expectPunctuation(";");
      return { kind: "Expression", waits, expression };
    }
    const equals = this.expectPunctuation("=");
    const value = this.parseExpression();
    this.expectPunctuation(";");
    return { kind: "Assign", waits, target: expression, equals, value };
  }

  private parseIfStatement(): IfStatement {
    this.expectKeyword("if");
    const condition = this.parseExpression();
    const thenBlock = this.parseBlock();
    if (!this.isKeyword("else")) return { kind: "If", condition, thenBlock, elseBranch: null };
    this.advance();
    const elseBranch = this.isKeyword("if") ? this.parseIfStatement() : this.parseBlock();
    return { kind: "If", condition, thenBlock, elseBranch };
  }

  private parseFunctionDeclaration(): FunctionDeclaration {
    this.expectKeyword("fn");
    const nameToken = this.expectIdentifier();
    this.expectPunctuation("(");
    const parameters = this.parseCommaSeparated(")", () => this.expectIdentifier());
    return { kind: "Function", name: nameToken.text, nameToken, parameters, body: this.parseBlock() };
  }

  private parseExpression(): Expression {
    return this.parseBinary(0);
  }

  private parseBinary(level: number): Expression {
    const operators = BINARY_LEVELS[level];
    if (operators === undefined) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const operatorToken = this.current;
      if (operatorToken.kind !== "punctuation" || !operators.includes(operatorToken.text)) return left;
      this.advance();
      const right = this.parseBinary(level + 1);
      left = { kind: "Binary", first: left.first, operator: operatorToken.text as BinaryOperator, operatorToken, left, right };
    }
  }

  private parseUnary(): Expression {
    const operatorToken = this.current;
    if (operatorToken.kind !== "punctuation" || (operatorToken.text !== "-" && operatorToken.text !== "!")) return this.parsePostfix();
    this.advance();
    const operand = this.parseUnary();
    return { kind: "Unary", first: operatorToken, operator: operatorToken.text as UnaryOperator, operatorToken, operand };
  }

  private parsePostfix(): Expression {
    let expression = this.parsePrimary();
    for (;;) {
      const token = this.current;
      if (token.kind !== "punctuation") return expression;
      if (token.text === "(") {
        this.advance();
        const argumentExpressions = this.parseCommaSeparated(")", () => this.parseExpression());
        expression = { kind: "Call", first: expression.first, callee: expression, openParenthesis: token, argumentExpressions };
      } else if (token.text === "[") {
        this.advance();
        const index = this.parseExpression();
        this.expectPunctuation("]");
        expression = { kind: "Index", first: expression.first, target: expression, openBracket: token, index };
      } else if (token.text === ".") {
        this.advance();
        const name = this.expectIdentifier();
        expression = { kind: "Field", first: expression.first, target: expression, dot: token, name: name.text };
      } else {
        return expression;
      }
    }
  }

  /** Comma separated items up to and including `closing`; the opening token is already consumed. */
  private parseCommaSeparated<Item>(closing: string, parseItem: () => Item): Item[] {
    const items: Item[] = [];
    if (!this.isPunctuation(closing)) {
      items.push(parseItem());
      while (this.isPunctuation(",")) {
        this.advance();
        items.push(parseItem());
      }
    }
    this.expectPunctuation(closing);
    return items;
  }

  private parsePrimary(): Expression {
    const first = this.current;
    switch (first.kind) {
      case "integer":
        this.advance();
        return { kind: "IntegerLiteral", first, value: first.value };
      case "string":
        this.advance();
        return { kind: "StringLiteral", first, value: first.value };
      case "identifier":
        this.advance();
        return { kind: "Identifier", first, name: first.text, token: first };
      case "keyword":
        if (first.text !== "true" && first.text !== "false" && first.text !== "nil") return this.reject(first);
        this.advance();
        return first.text === "nil" ? { kind: "NilLiteral", first } : { kind: "BooleanLiteral", first, value: first.text === "true" };
      case "punctuation":
        if (first.text === "(") {
          this.advance();
          const inner = this.parseExpression();
          this.expectPunctuation(")");
          return { kind: "Group", first, inner };
        }
        if (first.text === "[") {
          this.advance();
          return { kind: "ArrayLiteral", first, elements: this.parseCommaSeparated("]", () => this.parseExpression()) };
        }
        if (first.text === "{") {
          this.advance();
          return { kind: "RecordLiteral", first, fields: this.parseCommaSeparated("}", () => this.parseRecordField()) };
        }
        return this.reject(first);
      case "end":
      case "invalid":
        return this.reject(first);
    }
  }

  private parseRecordField(): RecordField {
    const nameToken = this.expectIdentifier();
    this.expectPunctuation(":");
    return { name: nameToken.text, nameToken, value: this.parseExpression() };
  }
}

/** Parses a token stream from `lex`. Grammar errors are returned, never thrown. O(n) time, O(depth) extra memory. */
export function parse(tokens: readonly Token[]): Result<Program> {
  try {
    return succeed(new Parser(tokens).parseProgram());
  } catch (failure) {
    if (failure instanceof GrammarFailure) return fail(failure.error);
    throw failure;
  }
}
