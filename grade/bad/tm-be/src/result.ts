/** Errors as values: modules return a Result instead of throwing across their boundary. */
export type Result<Value, Failure> = { ok: true; value: Value } | { ok: false; error: Failure };

export function succeed<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

export function fail<Failure>(error: Failure): Result<never, Failure> {
  return { ok: false, error };
}
