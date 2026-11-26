import type { Declaration, ScopeInfo } from "../analysis";
import { isBuiltinName } from "../language/builtin-names";
import { Closure, type BuiltinFunction, type RuntimeValue } from "./values";

/** The content of a binding that exists (is declared) but has not been initialized yet. */
export const UNINITIALIZED = Symbol("uninitialized");

type Slot = RuntimeValue | typeof UNINITIALIZED;

/** One execution of a scope: a cell for every declaration of its `ScopeInfo`, and the enclosing scope. */
export class Scope {
  readonly kind = "scope";
  markEpoch = 0;
  readonly slots: Slot[];

  constructor(
    readonly info: ScopeInfo,
    readonly parent: Scope | null,
  ) {
    this.slots = info.declarations.map(() => UNINITIALIZED);
  }
}

function closureDeclaration(declaration: Declaration) {
  if (declaration.declaredFunction === null) throw new Error(`hoisted declaration ${declaration.name} is not a function`);
  return declaration.declaredFunction;
}

/** A new scope with every `fn` declaration of `info` already bound to a closure over it (hoisting, spec 4.1). */
export function createScope(info: ScopeInfo, parent: Scope): Scope {
  const scope = new Scope(info, parent);
  for (const declaration of info.hoisted) scope.slots[declaration.slot] = new Closure(closureDeclaration(declaration), scope);
  return scope;
}

/** The outermost scope: the six builtins, all initialized. */
export function createBuiltinScope(info: ScopeInfo): Scope {
  const scope = new Scope(info, null);
  for (const declaration of info.declarations) {
    if (!isBuiltinName(declaration.name)) throw new Error(`unknown builtin ${declaration.name}`);
    const builtin: BuiltinFunction = { kind: "builtin", name: declaration.name };
    scope.slots[declaration.slot] = builtin;
  }
  return scope;
}

/** The scope `hops` links above `scope`. */
export function scopeAbove(scope: Scope, hops: number): Scope {
  let current = scope;
  for (let remaining = hops; remaining > 0; remaining -= 1) {
    if (current.parent === null) throw new Error("scope chain is shorter than the resolved hop count");
    current = current.parent;
  }
  return current;
}
