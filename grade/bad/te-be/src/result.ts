export type Success<Value> = { ok: true; value: Value };
export type Failure<Reason> = { ok: false; error: Reason };
export type Result<Value, Reason> = Success<Value> | Failure<Reason>;

export function succeed<Value>(value: Value): Success<Value> {
  return { ok: true, value };
}

export function fail<Reason>(error: Reason): Failure<Reason> {
  return { ok: false, error };
}
