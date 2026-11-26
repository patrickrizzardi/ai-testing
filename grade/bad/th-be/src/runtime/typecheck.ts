import type { SourcePosition } from "../errors";
import { failAt } from "./failure";
import { ArrayObject, RecordObject, type RuntimeValue } from "./values";

function describeType(value: RuntimeValue): string {
  if (value === null) return "nil";
  switch (typeof value) {
    case "number":
      return "integer";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return value.kind === "closure" || value.kind === "builtin" ? "function" : value.kind;
  }
}

function typeMismatch(value: RuntimeValue, expected: string, position: SourcePosition, role: string): never {
  return failAt(position, `${role} must be ${expected}, got ${describeType(value)}`);
}

export function expectInteger(value: RuntimeValue, position: SourcePosition, role: string): number {
  if (typeof value !== "number") typeMismatch(value, "an integer", position, role);
  return value;
}

export function expectBoolean(value: RuntimeValue, position: SourcePosition, role: string): boolean {
  if (typeof value !== "boolean") typeMismatch(value, "a boolean", position, role);
  return value;
}

export function expectString(value: RuntimeValue, position: SourcePosition, role: string): string {
  if (typeof value !== "string") typeMismatch(value, "a string", position, role);
  return value;
}

export function expectArray(value: RuntimeValue, position: SourcePosition, role: string): ArrayObject {
  if (!(value instanceof ArrayObject)) typeMismatch(value, "an array", position, role);
  return value;
}

export function expectRecord(value: RuntimeValue, position: SourcePosition, role: string): RecordObject {
  if (!(value instanceof RecordObject)) typeMismatch(value, "a record", position, role);
  return value;
}

/** An integer `index` with `0 <= index < length`. */
export function expectIndexWithin(index: RuntimeValue, length: number, position: SourcePosition): number {
  const integer = expectInteger(index, position, "an index");
  if (integer < 0 || integer >= length) failAt(position, `index ${integer} is out of range for length ${length}`);
  return integer;
}
