import type { Analysis } from "../analysis";
import type { RippleError } from "../errors";
import type { Program } from "../syntax/ast";
import type { RunOptions } from "../public-types";
import { Evaluator } from "./evaluator";
import { RuntimeFailure } from "./failure";
import { Heap } from "./heap";
import { createBuiltinScope, createScope } from "./scope";
import { closeStrand, openStrand } from "./strand";
import { drive } from "./suspension";

type ExecutionResult = {
  readonly output: string[];
  readonly error: RippleError | null;
  readonly heap: { allocs: number; frees: number };
};

/**
 * Runs an analysed program to its end or to its first RuntimeError. Rejects only when `clock.sleep`
 * rejects or the interpreter itself is faulty; a Ripple error is returned as a value.
 */
export async function execute(program: Program, analysis: Analysis, options: RunOptions): Promise<ExecutionResult> {
  const heap = new Heap();
  const evaluator = new Evaluator(analysis, { heap, clock: options.clock, io: options.io });
  const strand = openStrand(heap, 0);
  const programScope = createScope(analysis.scopeOf(program), createBuiltinScope(analysis.builtinScope));
  strand.roots.push(programScope);
  let error: RippleError | null = null;
  try {
    await drive(evaluator.runStatementList(program, programScope, strand));
    strand.roots.remove(programScope);
  } catch (failure) {
    if (!(failure instanceof RuntimeFailure)) throw failure;
    error = failure.error;
    strand.roots.clear();
  }
  // Collect before closing the strand: whatever it still held (a leak) must stay counted as live.
  heap.collect();
  closeStrand(heap, strand);
  return { output: strand.output, error, heap: heap.counts };
}
