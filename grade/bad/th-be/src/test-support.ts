import { analyze, type Analysis } from "./analysis";
import type { Program } from "./syntax/ast";
import { lex } from "./syntax/lexer";
import { parse } from "./syntax/parser";

/** The program `source` parses to. Throws when a test's own source has a syntax error: that is a broken test, not a result. */
export function programOf(source: string): Program {
  const parsed = parse(lex(source));
  if (!parsed.ok) throw new Error(`unexpected syntax error: ${parsed.error.message}`);
  return parsed.value;
}

/** The program and its analysis. Throws when a test's own source has a syntax or static error. */
export function analysisOf(source: string): { program: Program; analysis: Analysis } {
  const program = programOf(source);
  const analysis = analyze(program);
  if (!analysis.ok) throw new Error(`unexpected static error: ${analysis.error.message}`);
  return { program, analysis: analysis.value };
}
