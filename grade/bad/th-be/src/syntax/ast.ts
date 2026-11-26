import type { IdentifierToken, PunctuationToken, Token } from "./tokens";

/** Every expression node remembers its first token: conditions and iterables report errors there. */
type ExpressionBase = { readonly first: Token };

export type IntegerLiteral = ExpressionBase & { readonly kind: "IntegerLiteral"; readonly value: number };
export type StringLiteral = ExpressionBase & { readonly kind: "StringLiteral"; readonly value: string };
export type BooleanLiteral = ExpressionBase & { readonly kind: "BooleanLiteral"; readonly value: boolean };
export type NilLiteral = ExpressionBase & { readonly kind: "NilLiteral" };
export type Identifier = ExpressionBase & { readonly kind: "Identifier"; readonly name: string; readonly token: IdentifierToken };
export type ArrayLiteral = ExpressionBase & { readonly kind: "ArrayLiteral"; readonly elements: readonly Expression[] };
export type RecordField = { readonly name: string; readonly nameToken: IdentifierToken; readonly value: Expression };
export type RecordLiteral = ExpressionBase & { readonly kind: "RecordLiteral"; readonly fields: readonly RecordField[] };
export type Group = ExpressionBase & { readonly kind: "Group"; readonly inner: Expression };
export type UnaryOperator = "-" | "!";
export type Unary = ExpressionBase & { readonly kind: "Unary"; readonly operator: UnaryOperator; readonly operatorToken: PunctuationToken; readonly operand: Expression };
export type BinaryOperator = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";
export type Binary = ExpressionBase & {
  readonly kind: "Binary";
  readonly operator: BinaryOperator;
  readonly operatorToken: PunctuationToken;
  readonly left: Expression;
  readonly right: Expression;
};
export type Call = ExpressionBase & { readonly kind: "Call"; readonly callee: Expression; readonly openParenthesis: PunctuationToken; readonly argumentExpressions: readonly Expression[] };
export type Index = ExpressionBase & { readonly kind: "Index"; readonly target: Expression; readonly openBracket: PunctuationToken; readonly index: Expression };
export type Field = ExpressionBase & { readonly kind: "Field"; readonly target: Expression; readonly dot: PunctuationToken; readonly name: string };

export type Expression =
  | IntegerLiteral
  | StringLiteral
  | BooleanLiteral
  | NilLiteral
  | Identifier
  | ArrayLiteral
  | RecordLiteral
  | Group
  | Unary
  | Binary
  | Call
  | Index
  | Field;

/** `wait` before a statement; only `let` and simple statements may carry it. */
type Waitable = { readonly waits: boolean };

export type LetStatement = Waitable & { readonly kind: "Let"; readonly name: string; readonly nameToken: IdentifierToken; readonly initializer: Expression };
export type ExpressionStatement = Waitable & { readonly kind: "Expression"; readonly expression: Expression };
export type AssignStatement = Waitable & { readonly kind: "Assign"; readonly target: Expression; readonly equals: PunctuationToken; readonly value: Expression };
export type IfStatement = { readonly kind: "If"; readonly condition: Expression; readonly thenBlock: Block; readonly elseBranch: IfStatement | Block | null };
export type WhileStatement = { readonly kind: "While"; readonly condition: Expression; readonly body: Block };
export type ForStatement = { readonly kind: "For"; readonly variableToken: IdentifierToken; readonly iterable: Expression; readonly body: Block };
export type FunctionDeclaration = {
  readonly kind: "Function";
  readonly name: string;
  readonly nameToken: IdentifierToken;
  readonly parameters: readonly IdentifierToken[];
  readonly body: Block;
};
export type ReturnStatement = { readonly kind: "Return"; readonly keyword: Token; readonly value: Expression | null };

export type Statement = LetStatement | ExpressionStatement | AssignStatement | IfStatement | WhileStatement | ForStatement | FunctionDeclaration | ReturnStatement;

export type Block = { readonly kind: "Block"; readonly statements: readonly Statement[] };
export type Program = { readonly kind: "Program"; readonly statements: readonly Statement[] };
