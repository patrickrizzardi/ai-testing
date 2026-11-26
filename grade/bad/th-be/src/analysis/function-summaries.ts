import { requireEntry } from "../invariants";
import type { FunctionDeclaration } from "../syntax/ast";
import type { FunctionFacts } from "./function-facts";

/** What the concurrency plan needs to know about a function (spec section 8). */
export type FunctionSummary = {
  readonly asynchronous: boolean;
  readonly contained: boolean;
  /** Names occurring in `reach(F)` that resolve outside their own function, builtins excluded (the `uses` of spec 9.2). */
  readonly reachOutsideNames: ReadonlySet<string>;
};

/**
 * The least set of asynchronous functions: those calling `sleep`/`fetch` by name, then every
 * function calling an asynchronous one by name. O(functions + calls) time and memory.
 */
function findAsynchronousFunctions(facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): Set<FunctionDeclaration> {
  const callers = new Map<FunctionDeclaration, FunctionDeclaration[]>();
  for (const [caller, callerFacts] of facts) {
    for (const callee of callerFacts.calledFunctions) {
      const callersOfCallee = callers.get(callee);
      if (callersOfCallee === undefined) callers.set(callee, [caller]);
      else callersOfCallee.push(caller);
    }
  }
  const asynchronous = new Set<FunctionDeclaration>();
  const pending: FunctionDeclaration[] = [];
  for (const [functionDeclaration, functionFacts] of facts) {
    if (functionFacts.callsAsynchronousBuiltin) pending.push(functionDeclaration);
  }
  for (let functionDeclaration = pending.pop(); functionDeclaration !== undefined; functionDeclaration = pending.pop()) {
    if (asynchronous.has(functionDeclaration)) continue;
    asynchronous.add(functionDeclaration);
    pending.push(...(callers.get(functionDeclaration) ?? []));
  }
  return asynchronous;
}

/** `fn` and every function it calls by name, directly or transitively. O(functions + calls). */
function reach(functionDeclaration: FunctionDeclaration, facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): Set<FunctionDeclaration> {
  const reached = new Set<FunctionDeclaration>();
  const pending = [functionDeclaration];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next)) continue;
    reached.add(next);
    pending.push(...requireEntry(facts, next, "facts of a function").calledFunctions);
  }
  return reached;
}

/** The four containment rules of spec section 8 over a whole `reach` set. */
function isContained(reached: ReadonlySet<FunctionDeclaration>, facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): boolean {
  const reachedFacts = [...reached].map((functionDeclaration) => requireEntry(facts, functionDeclaration, "facts of a function"));
  const anyMutation = reachedFacts.some((functionFacts) => functionFacts.hasMutation);
  return reachedFacts.every(
    (functionFacts) =>
      !functionFacts.hasOpaqueCall && !functionFacts.assignsNonLocalVariable && !functionFacts.hasUnsafeMutation && !(anyMutation && functionFacts.hasNonLocalVariableOccurrence),
  );
}

/**
 * Asynchrony, containment and reach-wide outside names of every function.
 * O(F * (F + calls + names)) time, O(F * names) memory in the worst case: per function, one `reach` walk
 * and a merge of the outside names of everything reached.
 */
export function summarizeFunctions(facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): Map<FunctionDeclaration, FunctionSummary> {
  const asynchronous = findAsynchronousFunctions(facts);
  const summaries = new Map<FunctionDeclaration, FunctionSummary>();
  for (const functionDeclaration of facts.keys()) {
    const reached = reach(functionDeclaration, facts);
    const reachOutsideNames = new Set<string>();
    for (const reachedFunction of reached) {
      for (const name of requireEntry(facts, reachedFunction, "facts of a function").outsideNames) reachOutsideNames.add(name);
    }
    summaries.set(functionDeclaration, { asynchronous: asynchronous.has(functionDeclaration), contained: isContained(reached, facts), reachOutsideNames });
  }
  return summaries;
}
