import { runtimeErrorAt, type RippleError, type SourcePosition } from "../errors";

/** The one exception of the evaluator: carries a Ripple RuntimeError up to the strand that owns it. */
export class RuntimeFailure extends Error {
  constructor(readonly error: RippleError) {
    super(error.message);
  }
}

export function failAt(position: SourcePosition, message: string): never {
  throw new RuntimeFailure(runtimeErrorAt(position, message));
}
