import type { Block, Expression, FunctionDeclaration, Statement } from "./ast";

/** The direct sub-expressions of `expression`, in evaluation order. O(children). */
function childExpressions(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "IntegerLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "Identifier":
      return [];
    case "ArrayLiteral":
      return expression.elements;
    case "RecordLiteral":
      return expression.fields.map((field) => field.value);
    case "Group":
      return [expression.inner];
    case "Unary":
      return [expression.operand];
    case "Binary":
      return [expression.left, expression.right];
    case "Call":
      return [expression.callee, ...expression.args];
    case "Index":
      return [expression.target, expression.index];
    case "Field":
      return [expression.target];
  }
}

/** Calls `visit` on `expression` and every expression below it, parents before children. O(size of the expression). */
export function visitExpression(expression: Expression, visit: (expression: Expression) => void): void {
  visit(expression);
  for (const child of childExpressions(expression)) visitExpression(child, visit);
}

/** The expressions written directly in `statement` (not those of its nested blocks). */
export function ownExpressions(statement: Statement): readonly Expression[] {
  switch (statement.kind) {
    case "Let":
      return [statement.initializer];
    case "Expression":
      return [statement.expression];
    case "Assign":
      return [statement.target, statement.value];
    case "If":
    case "While":
      return [statement.condition];
    case "For":
      return [statement.iterable];
    case "Return":
      return statement.value === null ? [] : [statement.value];
    case "Function":
      return [];
  }
}

/** True when `expression` contains a call expression at any depth. */
export function containsCall(expression: Expression): boolean {
  let found = false;
  visitExpression(expression, (visited) => {
    if (visited.kind === "Call") found = true;
  });
  return found;
}

/** The blocks written directly in `statement`, including those of an `else if` chain and a function body. */
export function nestedBlocks(statement: Statement): readonly Block[] {
  switch (statement.kind) {
    case "If":
      if (statement.elseBranch === null) return [statement.thenBlock];
      return statement.elseBranch.kind === "Block" ? [statement.thenBlock, statement.elseBranch] : [statement.thenBlock, ...nestedBlocks(statement.elseBranch)];
    case "While":
    case "For":
    case "Function":
      return [statement.body];
    case "Let":
    case "Expression":
    case "Assign":
    case "Return":
      return [];
  }
}

/**
 * Calls `visit` on every statement in `statements` and in the blocks below them, in source order.
 * Bodies of function declarations are entered only when `intoFunctions` is true.
 */
export function visitStatements(statements: readonly Statement[], visit: (statement: Statement) => void, intoFunctions: boolean): void {
  for (const statement of statements) {
    visit(statement);
    if (statement.kind === "Function" && !intoFunctions) continue;
    for (const block of nestedBlocks(statement)) visitStatements(block.statements, visit, intoFunctions);
  }
}

/** Every function declaration in `statements`, nested ones included, in source order. */
export function collectFunctions(statements: readonly Statement[]): FunctionDeclaration[] {
  const functions: FunctionDeclaration[] = [];
  visitStatements(
    statements,
    (statement) => {
      if (statement.kind === "Function") functions.push(statement);
    },
    true,
  );
  return functions;
}
