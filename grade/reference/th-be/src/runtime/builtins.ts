import type { SourcePosition } from "../errors";
import type { BuiltinName } from "../language/builtin-names";
import type { Clock, IoEntry, Value } from "../public-types";
import { displayValue } from "./display";
import { failAt } from "./failure";
import type { Heap } from "./heap";
import type { Strand } from "./strand";
import { awaitPromise, type Evaluation } from "./suspension";
import { expectArray, expectInteger, expectRecord, expectString } from "./typecheck";
import { ArrayObject, RecordObject, type RuntimeValue } from "./values";

export const BUILTIN_ARITY: Readonly<Record<BuiltinName, number>> = { print: 1, len: 1, push: 2, keys: 1, sleep: 1, fetch: 1 };

/** What builtins use from the run: the heap, the clock and the `io` table. */
export type BuiltinEnvironment = {
  readonly heap: Heap;
  readonly clock: Clock;
  readonly io: Readonly<Record<string, IoEntry>> | undefined;
};

type BuiltinCall = {
  readonly environment: BuiltinEnvironment;
  readonly strand: Strand;
  /** Argument values, already evaluated and checked against the arity. */
  readonly argumentValues: readonly RuntimeValue[];
  /** The call's `(` token: where every builtin failure is located. */
  readonly position: SourcePosition;
};

function argumentAt(call: BuiltinCall, index: number): RuntimeValue {
  const argument = call.argumentValues[index];
  if (argument === undefined) throw new Error(`builtin called with ${call.argumentValues.length} arguments after the arity check`);
  return argument;
}

/** A fresh copy of an `io` value with one heap object per array and record (spec 7, `fetch`). */
function instantiate(value: Value, heap: Heap): RuntimeValue {
  if (Array.isArray(value)) return heap.createArray(value.map((element) => instantiate(element, heap)));
  if (typeof value === "object" && value !== null) {
    return heap.createRecord(new Map(Object.entries(value).map(([name, field]): [string, RuntimeValue] => [name, instantiate(field, heap)])));
  }
  return value;
}

function lengthOf(call: BuiltinCall): number {
  const subject = argumentAt(call, 0);
  if (typeof subject === "string") return subject.length;
  if (subject instanceof ArrayObject) return subject.items.length;
  if (subject instanceof RecordObject) return subject.fields.size;
  return failAt(call.position, "len needs a string, an array or a record");
}

function* sleepFor(call: BuiltinCall): Evaluation<RuntimeValue> {
  const milliseconds = expectInteger(argumentAt(call, 0), call.position, "the argument of sleep");
  if (milliseconds < 0) failAt(call.position, "sleep needs a non-negative integer");
  yield* awaitPromise(call.environment.clock.sleep(milliseconds));
  return null;
}

function* fetchKey(call: BuiltinCall): Evaluation<RuntimeValue> {
  const key = expectString(argumentAt(call, 0), call.position, "the argument of fetch");
  const { io, clock, heap } = call.environment;
  const entry = io !== undefined && Object.hasOwn(io, key) ? io[key] : undefined;
  if (entry === undefined) return failAt(call.position, `fetch has no entry for key "${key}"`);
  yield* awaitPromise(clock.sleep(entry.latencyMs));
  return instantiate(entry.value, heap);
}

/** Runs builtin `name`; arguments are already evaluated and counted. Only `sleep` and `fetch` yield. */
export function* callBuiltin(name: BuiltinName, call: BuiltinCall): Evaluation<RuntimeValue> {
  switch (name) {
    case "print":
      call.strand.output.push(displayValue(argumentAt(call, 0), true));
      return null;
    case "len":
      return lengthOf(call);
    case "push":
      expectArray(argumentAt(call, 0), call.position, "the first argument of push").items.push(argumentAt(call, 1));
      return null;
    case "keys":
      return call.environment.heap.createArray([...expectRecord(argumentAt(call, 0), call.position, "the argument of keys").fields.keys()]);
    case "sleep":
      return yield* sleepFor(call);
    case "fetch":
      return yield* fetchKey(call);
  }
}
