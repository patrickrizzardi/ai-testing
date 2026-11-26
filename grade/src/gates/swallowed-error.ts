import ts from "typescript";
import { findingAt, parseSource, unwrapExpression, walk } from "../ast.ts";
import type { Finding, SourceFile } from "../types.ts";

/** A value that carries no information about the failure it replaces. */
function isLiteralDefault(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return true; // bare `return;`
  const inner = unwrapExpression(expression);
  switch (inner.kind) {
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.VoidExpression:
      return true;
    case ts.SyntaxKind.Identifier:
      return (inner as ts.Identifier).text === "undefined";
    case ts.SyntaxKind.PrefixUnaryExpression:
      return (inner as ts.PrefixUnaryExpression).operand.kind === ts.SyntaxKind.NumericLiteral;
    case ts.SyntaxKind.ArrayLiteralExpression:
      return (inner as ts.ArrayLiteralExpression).elements.length === 0;
    case ts.SyntaxKind.ObjectLiteralExpression:
      return (inner as ts.ObjectLiteralExpression).properties.length === 0;
    default:
      return false;
  }
}

/** Describes why a statement list swallows the error, or undefined when it handles it. */
function swallowReason(statements: readonly ts.Statement[]): string | undefined {
  if (statements.length === 0) return "empty body";
  const onlyStatement = statements[0];
  if (statements.length === 1 && onlyStatement && ts.isReturnStatement(onlyStatement)) {
    return isLiteralDefault(onlyStatement.expression) ? "only returns a literal default" : undefined;
  }
  return undefined;
}

function handlerReason(handler: ts.Expression): string | undefined {
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return undefined;
  if (ts.isBlock(handler.body)) return swallowReason(handler.body.statements);
  return isLiteralDefault(handler.body) ? "only returns a literal default" : undefined;
}

/**
 * Flags `catch` clauses and `.catch(handler)` calls that discard the error:
 * empty, or whose only statement returns a literal default.
 * O(n) time and memory per file.
 */
export function scanSwallowedError(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const sourceFile = parseSource(file);
    walk(sourceFile, (node) => {
      if (ts.isCatchClause(node)) {
        const reason = swallowReason(node.block.statements);
        if (reason) {
          findings.push(findingAt(sourceFile, node.getStart(sourceFile), `catch block swallows the error: ${reason}`));
        }
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "catch" &&
        node.arguments.length === 1 &&
        node.arguments[0]
      ) {
        const reason = handlerReason(node.arguments[0]);
        if (reason) {
          findings.push(findingAt(sourceFile, node.expression.name.getStart(sourceFile), `.catch() handler swallows the error: ${reason}`));
        }
      }
    });
  }
  return findings;
}
