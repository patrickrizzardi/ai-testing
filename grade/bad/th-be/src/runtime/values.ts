import type { BuiltinName } from "../language/builtin-names";
import type { FunctionDeclaration } from "../syntax/ast";
import type { Scope } from "./scope";

/** Shared by everything the heap counts: arrays and records. `markEpoch` belongs to the heap's collector. */
abstract class HeapObject {
  markEpoch = 0;
}

export class ArrayObject extends HeapObject {
  readonly kind = "array";
  constructor(readonly items: RuntimeValue[]) {
    super();
  }
}

export class RecordObject extends HeapObject {
  readonly kind = "record";
  /** A Map keeps insertion order, and re-setting a key keeps its place. */
  constructor(readonly fields: Map<string, RuntimeValue>) {
    super();
  }
}

/** A `fn` declaration together with the scope it captured. Not a heap object, but it reaches its scope. */
export class Closure {
  readonly kind = "closure";
  constructor(
    readonly declaration: FunctionDeclaration,
    readonly scope: Scope,
  ) {}
}

export type BuiltinFunction = { readonly kind: "builtin"; readonly name: BuiltinName };

export type HeapValue = ArrayObject | RecordObject;

export type RuntimeValue = null | boolean | number | string | HeapValue | Closure | BuiltinFunction;

export function isHeapValue(value: RuntimeValue): value is HeapValue {
  return typeof value === "object" && value !== null && (value.kind === "array" || value.kind === "record");
}
