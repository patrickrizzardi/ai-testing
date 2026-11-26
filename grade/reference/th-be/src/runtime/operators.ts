import type { BinaryOperator, UnaryOperator } from "../syntax/ast";
import type { SourcePosition } from "../errors";
import { valuesEqual } from "./equality";
import { failAt } from "./failure";
import { checkedInteger } from "./integers";
import { expectBoolean, expectInteger } from "./typecheck";
import type { RuntimeValue } from "./values";

/** `-a` and `!a` (spec 6.1). */
export function applyUnary(operator: UnaryOperator, operand: RuntimeValue, operatorPosition: SourcePosition): RuntimeValue {
  if (operator === "!") return !expectBoolean(operand, operatorPosition, "the operand of '!'");
  return checkedInteger(-expectInteger(operand, operatorPosition, "the operand of '-'"), operatorPosition);
}

type IntegerOperator = "+" | "-" | "*" | "/" | "%";

/** Exact result of an integer operator; division and modulo truncate toward zero, and `%` is JavaScript's exact remainder. */
function integerResult(operator: IntegerOperator, left: number, right: number, position: SourcePosition): number {
  if ((operator === "/" || operator === "%") && right === 0) failAt(position, `${operator === "/" ? "division" : "modulo"} by zero`);
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return (left - (left % right)) / right;
    case "%":
      return left % right;
  }
}

/** -1, 0 or 1: numeric order of two integers or code-unit order of two strings; anything else is a type error. */
function compareOrdered(left: RuntimeValue, right: RuntimeValue, position: SourcePosition): number {
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  const leftInteger = expectInteger(left, position, "an operand");
  const rightInteger = expectInteger(right, position, "an operand");
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}

function arithmetic(operator: IntegerOperator, left: RuntimeValue, right: RuntimeValue, position: SourcePosition): number {
  const exact = integerResult(operator, expectInteger(left, position, "an operand"), expectInteger(right, position, "an operand"), position);
  return checkedInteger(exact, position);
}

/** Every binary operator except the short-circuiting `&&` and `||`, which the evaluator owns. */
export function applyBinary(operator: Exclude<BinaryOperator, "&&" | "||">, left: RuntimeValue, right: RuntimeValue, position: SourcePosition): RuntimeValue {
  switch (operator) {
    case "==":
      return valuesEqual(left, right);
    case "!=":
      return !valuesEqual(left, right);
    case "<":
      return compareOrdered(left, right, position) < 0;
    case "<=":
      return compareOrdered(left, right, position) <= 0;
    case ">":
      return compareOrdered(left, right, position) > 0;
    case ">=":
      return compareOrdered(left, right, position) >= 0;
    case "+":
      return typeof left === "string" && typeof right === "string" ? left + right : arithmetic(operator, left, right, position);
    case "-":
    case "*":
    case "/":
    case "%":
      return arithmetic(operator, left, right, position);
  }
}
