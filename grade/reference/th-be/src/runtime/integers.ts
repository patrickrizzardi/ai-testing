import type { SourcePosition } from "../errors";
import { failAt } from "./failure";

/** The one range rule of spec section 5: `exact` must be a safe integer; -0 becomes 0. */
export function checkedInteger(exact: number, position: SourcePosition): number {
  if (!Number.isSafeInteger(exact)) failAt(position, "integer overflow");
  return exact === 0 ? 0 : exact;
}
