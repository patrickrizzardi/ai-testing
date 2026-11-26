import { analyze } from "./analysis";
import type { RippleError } from "./errors";
import type { RunOptions, RunResult } from "./public-types";
import { execute } from "./runtime/execute";
import { lex } from "./syntax/lexer";
import { parse } from "./syntax/parser";

export type { Clock, IoEntry, RunError, RunOptions, RunResult, Value, ValueRecord } from "./public-types";

/** A SyntaxError is found before anything runs: no output, nothing allocated (spec 1). */
function rejectedBeforeRunning(error: RippleError): RunResult {
  return { output: [], error, heap: { allocs: 0, frees: 0 } };
}

/** Parses, checks and executes one Ripple program. Several calls are independent: no state is shared. */
export async function run(source: string, options: RunOptions): Promise<RunResult> {
  const parsed = parse(lex(source));
  if (!parsed.ok) return rejectedBeforeRunning(parsed.error);
  const analysis = analyze(parsed.value);
  if (!analysis.ok) return rejectedBeforeRunning(analysis.error);
  return execute(parsed.value, analysis.value, options);
}
