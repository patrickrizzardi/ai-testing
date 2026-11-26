import ts from "typescript";
import { findingAt, parseSource, unwrapExpression, walk } from "../ast.ts";
import type { Finding, SourceFile } from "../types.ts";

const SQL_METHODS = new Set(["query", "prepare", "run", "exec", "all", "get", "values"]);

// `.get`/`.run`/`.exec`/`.values` also exist on Map, RegExp, Set and others, so
// an interpolated string only counts as SQL when its fixed text reads as SQL.
const SQL_KEYWORDS = /\b(select|insert|update|delete|create|drop|alter|pragma|replace|where|from|into)\b/i;

function isConcatenation(node: ts.Expression): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function concatenationOperands(expression: ts.Expression): ts.Expression[] {
  const inner = unwrapExpression(expression);
  if (!isConcatenation(inner)) return [inner];
  return [...concatenationOperands(inner.left), ...concatenationOperands(inner.right)];
}

/** The fixed text of a string-ish operand; undefined for any other expression. */
function fixedText(operand: ts.Expression): string | undefined {
  if (ts.isStringLiteral(operand) || ts.isNoSubstitutionTemplateLiteral(operand)) return operand.text;
  if (ts.isTemplateExpression(operand)) {
    return [operand.head.text, ...operand.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return undefined;
}

/**
 * The fixed text of a template with substitutions, or of a concatenation that
 * mixes a string literal with at least one non-literal operand. Undefined for
 * everything else, including a concatenation of literals only.
 */
function dynamicStringText(expression: ts.Expression): string | undefined {
  const operands = concatenationOperands(expression);
  const isDynamic = operands.some((operand) => ts.isTemplateExpression(operand) || fixedText(operand) === undefined);
  const texts = operands.map(fixedText).filter((text): text is string => text !== undefined);
  if (!isDynamic || texts.length === 0) return undefined;
  return texts.join(" ");
}

/**
 * Flags `.query/.prepare/.run/.exec/.all/.get/.values(sql, ...)` calls whose
 * first argument is a template literal with substitutions or a string
 * concatenation that reads as SQL. Tagged templates are not flagged: their tag
 * receives the values separately. A `const sql = ...` passed by name is not
 * followed. O(n) time and memory per file (concatenation chains are walked once).
 */
export function scanSqlInjection(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const sourceFile = parseSource(file);
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      const sqlArgument = node.arguments[0];
      if (!SQL_METHODS.has(method) || !sqlArgument) return;
      const text = dynamicStringText(sqlArgument);
      if (text === undefined || !SQL_KEYWORDS.test(text)) return;
      const kind = isConcatenation(unwrapExpression(sqlArgument)) ? "string concatenation" : "template literal";
      findings.push(findingAt(sourceFile, sqlArgument.getStart(sourceFile), `.${method}() builds SQL from a ${kind}; bind parameters instead`));
    });
  }
  return findings;
}
