import { ArrayObject, RecordObject, type RuntimeValue } from "./values";

/** Structural equality of spec 5.2. Closures and builtins are equal only to themselves. O(size of the compared values). */
export function valuesEqual(left: RuntimeValue, right: RuntimeValue): boolean {
  if (left instanceof ArrayObject && right instanceof ArrayObject) {
    return left.items.length === right.items.length && left.items.every((element, position) => valuesEqual(element, right.items[position] as RuntimeValue));
  }
  if (left instanceof RecordObject && right instanceof RecordObject) {
    if (left.fields.size !== right.fields.size) return false;
    for (const [name, value] of left.fields) {
      const other = right.fields.get(name);
      if (other === undefined || !valuesEqual(value, other)) return false;
    }
    return true;
  }
  return left === right;
}
