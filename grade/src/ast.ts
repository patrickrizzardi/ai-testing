import ts from "typescript";
import type { Finding, SourceFile } from "./types.ts";

export function parseSource(file: SourceFile): ts.SourceFile {
  const scriptKind = file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind);
}

export function findingAt(sourceFile: ts.SourceFile, position: number, message: string): Finding {
  const { line } = sourceFile.getLineAndCharacterOfPosition(position);
  return { file: sourceFile.fileName, line: line + 1, message };
}

/** O(n) time: visits every node and token once. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export interface CommentRange {
  pos: number;
  text: string;
}

/**
 * Every comment in the file, found through the parser so that comment-like text
 * inside strings, template literals and regexes is never returned.
 * O(n) time and memory: visits each token once; positions dedupe comments seen
 * as both the trailing comment of one token and the leading comment of the next.
 */
export function collectComments(sourceFile: ts.SourceFile): CommentRange[] {
  const text = sourceFile.text;
  const seenPositions = new Set<number>();
  const comments: CommentRange[] = [];
  const record = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seenPositions.has(range.pos)) continue;
      seenPositions.add(range.pos);
      comments.push({ pos: range.pos, text: text.slice(range.pos, range.end) });
    }
  };
  const visitToken = (node: ts.Node): void => {
    // JSDoc nodes sit inside a comment that the leading-trivia scan already returns whole.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      record(ts.getLeadingCommentRanges(text, node.getFullStart()));
      record(ts.getTrailingCommentRanges(text, node.getEnd()));
      return;
    }
    for (const child of children) visitToken(child);
  };
  visitToken(sourceFile);
  return comments.sort((first, second) => first.pos - second.pos);
}

/** Strips parentheses, `as`, `satisfies`, `<T>x` and `!` so patterns match the value underneath. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}
