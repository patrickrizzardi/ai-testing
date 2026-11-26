import { describe, expect, test } from "bun:test";
import { RuntimeFailure } from "./failure";
import { applyBinary, applyUnary } from "./operators";
import type { RuntimeValue } from "./values";

const OPERATOR_POSITION = { line: 3, column: 7 };
const LARGEST = Number.MAX_SAFE_INTEGER;

function failureOf(action: () => RuntimeValue): { line: number; column: number } {
  try {
    action();
  } catch (failure) {
    if (failure instanceof RuntimeFailure) return { line: failure.error.line, column: failure.error.column };
    throw failure;
  }
  throw new Error("expected a RuntimeFailure");
}

describe("integer arithmetic (spec 5, 6.1)", () => {
  // Bug: floor instead of truncating division or modulo, or a negative zero result. Tier: High (pure math).
  test.each([
    ["/", 7, 2, 3],
    ["/", -7, 2, -3],
    ["/", 7, -2, -3],
    ["/", -7, -2, 3],
    ["%", -7, 3, -1],
    ["%", 7, -2, 1],
    ["%", 7, 3, 1],
    ["/", 0, -5, 0],
    ["%", -4, 2, 0],
    ["*", 0, -5, 0],
    ["-", 0, 0, 0],
    ["/", LARGEST, 2, 4503599627370495],
    ["/", -LARGEST, 3, -3002399751580330],
    ["%", LARGEST, 10, 1],
    ["+", LARGEST, -LARGEST, 0],
  ] as const)("%s of %d and %d is %d", (operator, left, right, expected) => {
    const result = applyBinary(operator, left, right, OPERATOR_POSITION);
    expect(result).toBe(expected);
    expect(Object.is(result, -0)).toBe(false);
  });

  // Bug: a result beyond 2^53 - 1, or one that lost precision on the way, returned instead of failing. Tier: High (pure math).
  test.each([
    ["+", LARGEST, 1],
    ["-", -LARGEST, 1],
    ["*", LARGEST, 2],
    ["*", 94906266, 94906266],
  ] as const)("%s of %d and %d is outside the integer range", (operator, left, right) => {
    expect(failureOf(() => applyBinary(operator, left, right, OPERATOR_POSITION))).toEqual(OPERATOR_POSITION);
  });

  // Bug: division or modulo by zero giving Infinity or NaN instead of a RuntimeError. Tier: High (pure math).
  test.each(["/", "%"] as const)("%s by zero fails at the operator", (operator) => {
    expect(failureOf(() => applyBinary(operator, 5, 0, OPERATOR_POSITION))).toEqual(OPERATOR_POSITION);
  });

  // Bug: `-0` leaking out as a second zero. Tier: High (pure math).
  test("negation of zero is zero, not negative zero", () => {
    expect(Object.is(applyUnary("-", 0, OPERATOR_POSITION), -0)).toBe(false);
  });
});

describe("operand types (spec 6.1)", () => {
  // Bug: an operator coercing mixed or non-integer operands instead of failing. Tier: High (pure math).
  test.each([
    ["+", 1, "a"],
    ["+", "a", 1],
    ["+", true, true],
    ["+", null, null],
    ["-", "a", "b"],
    ["<", 1, "a"],
    ["<", true, false],
    [">=", null, null],
  ] as const)("%s of %j and %j is a type error at the operator", (operator, left, right) => {
    expect(failureOf(() => applyBinary(operator, left, right, OPERATOR_POSITION))).toEqual(OPERATOR_POSITION);
  });

  // Bug: strings ordered by locale or code point instead of UTF-16 code units, or a prefix ordered after its extension. Tier: High (pure math).
  test("strings add and compare by UTF-16 code units, a prefix being smaller", () => {
    expect(applyBinary("+", "ab", "c", OPERATOR_POSITION)).toBe("abc");
    expect(applyBinary("<", "ab", "abc", OPERATOR_POSITION)).toBe(true);
    expect(applyBinary("<", "Z", "a", OPERATOR_POSITION)).toBe(true);
    expect(applyBinary(">=", "b", "b", OPERATOR_POSITION)).toBe(true);
  });

  // Bug: equality failing, or equating values of different types. Tier: High (pure math).
  test("equality never fails and different types are never equal", () => {
    expect(applyBinary("==", 1, "1", OPERATOR_POSITION)).toBe(false);
    expect(applyBinary("!=", null, false, OPERATOR_POSITION)).toBe(true);
    expect(applyBinary("==", null, null, OPERATOR_POSITION)).toBe(true);
  });

  // Bug: `!` or unary `-` coercing its operand. Tier: High (pure math).
  test("! needs a boolean and - needs an integer", () => {
    expect(failureOf(() => applyUnary("!", 1, OPERATOR_POSITION))).toEqual(OPERATOR_POSITION);
    expect(failureOf(() => applyUnary("-", true, OPERATOR_POSITION))).toEqual(OPERATOR_POSITION);
  });
});
