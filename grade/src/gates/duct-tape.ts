import ts from "typescript";
import { collectComments, findingAt, parseSource, walk } from "../ast.ts";
import type { Finding, SourceFile } from "../types.ts";

const TODO_MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;
const SUPPRESSION_DIRECTIVES = ["@ts-ignore", "@ts-expect-error", "eslint-disable"];

/**
 * Flags TODO/FIXME/HACK/XXX comments, type-check or lint suppression comments
 * and `any` types (`: any`, `as any`, `any[]`, `Array<any>`...).
 * Markers are matched upper-case only, so ordinary prose ("hack" in a sentence)
 * is not flagged. O(n) time and memory per file.
 */
export function scanDuctTape(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const sourceFile = parseSource(file);
    for (const comment of collectComments(sourceFile)) {
      const marker = TODO_MARKER.exec(comment.text);
      if (marker) findings.push(findingAt(sourceFile, comment.pos, `${marker[1]} comment`));
      for (const directive of SUPPRESSION_DIRECTIVES) {
        if (comment.text.includes(directive)) {
          findings.push(findingAt(sourceFile, comment.pos, `${directive} suppression comment`));
        }
      }
    }
    walk(sourceFile, (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        findings.push(findingAt(sourceFile, node.getStart(sourceFile), "`any` type"));
      }
    });
  }
  return findings;
}
