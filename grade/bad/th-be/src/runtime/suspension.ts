/**
 * An evaluation runs synchronously until it must wait for the clock (or for other strands); it then
 * yields the promise to wait for. `drive` is the only place that awaits, so strands switch only there.
 */
export type Evaluation<Result> = Generator<Promise<unknown>, Result, unknown>;

/** Waits for `promise` inside an evaluation. */
export function* awaitPromise<Resolved>(promise: Promise<Resolved>): Evaluation<Resolved> {
  const resolved = yield promise;
  return resolved as Resolved;
}

/** Runs `evaluation` to its end, awaiting each promise it yields. The part before the first yield runs synchronously. */
export async function drive<Result>(evaluation: Evaluation<Result>): Promise<Result> {
  let step = evaluation.next();
  while (!step.done) step = evaluation.next(await step.value);
  return step.value;
}
