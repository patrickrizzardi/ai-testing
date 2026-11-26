import type { RunError } from "./public-types";

/** A place in the source text: 1-based line, 1-based column in UTF-16 code units. */
export type SourcePosition = { readonly line: number; readonly column: number };

/** Ripple's own error: the only error shape that ever reaches `RunResult.error`. */
export type RippleError = RunError;

export type Result<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: RippleError };

export function succeed<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

export function fail<Value>(error: RippleError): Result<Value> {
  return { ok: false, error };
}

export function syntaxErrorAt(position: SourcePosition, message: string): RippleError {
  return { kind: "SyntaxError", message, line: position.line, column: position.column };
}

export function runtimeErrorAt(position: SourcePosition, message: string): RippleError {
  return { kind: "RuntimeError", message, line: position.line, column: position.column };
}

/** True when `left` is located strictly before `right` (line first, then column). */
function isBefore(left: SourcePosition, right: SourcePosition): boolean {
  return left.line < right.line || (left.line === right.line && left.column < right.column);
}

/** The error that comes first in the source; `errors` must not be empty. O(n). */
export function earliestError(errors: readonly [RippleError, ...RippleError[]]): RippleError {
  let earliest = errors[0];
  for (const candidate of errors) {
    if (isBefore(candidate, earliest)) earliest = candidate;
  }
  return earliest;
}
