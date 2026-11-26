import type { FunctionDeclaration } from "../syntax/ast";
import type { FunctionFacts } from "./function-facts";

/** What the concurrency plan needs to know about a function (spec section 8). */
export type FunctionSummary = {
  readonly asynchronous: boolean;
  readonly contained: boolean;
  /** Names occurring in `reach(F)` that resolve outside their own function, builtins excluded (the `uses` of spec 9.2). */
  readonly reachOutsideNames: ReadonlySet<string>;
};

function factsOf(facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>, functionDeclaration: FunctionDeclaration): FunctionFacts {
  const found = facts.get(functionDeclaration);
  if (found === undefined) throw new Error(`no facts collected for function ${functionDeclaration.name}`);
  return found;
}

/**
 * The least set of asynchronous functions: those calling `sleep`/`fetch` by name, then every
 * function calling an asynchronous one by name. O(functions + calls) time and memory.
 */
function findAsynchronousFunctions(facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): Set<FunctionDeclaration> {
  const callers = new Map<FunctionDeclaration, FunctionDeclaration[]>();
  for (const [caller, callerFacts] of facts) {
    for (const callee of callerFacts.calledFunctions) callers.set(callee, [...(callers.get(callee) ?? []), caller]);
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
    pending.push(...factsOf(facts, next).calledFunctions);
  }
  return reached;
}

/** The four containment rules of spec section 8 over a whole `reach` set. */
function isContained(reached: ReadonlySet<FunctionDeclaration>, facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): boolean {
  const reachedFacts = [...reached].map((functionDeclaration) => factsOf(facts, functionDeclaration));
  const anyMutation = reachedFacts.some((functionFacts) => functionFacts.hasMutation);
  return reachedFacts.every(
    (functionFacts) =>
      !functionFacts.hasOpaqueCall && !functionFacts.assignsNonLocalVariable && !functionFacts.hasUnsafeMutation && !(anyMutation && functionFacts.hasNonLocalVariableOccurrence),
  );
}

/**
 * Asynchrony, containment and reach-wide outside names of every function.
 * O(F * (F + calls)) time, O(F * names) memory in the worst case: one `reach` walk per function.
 */
export function summarizeFunctions(facts: ReadonlyMap<FunctionDeclaration, FunctionFacts>): Map<FunctionDeclaration, FunctionSummary> {
  const asynchronous = findAsynchronousFunctions(facts);
  const summaries = new Map<FunctionDeclaration, FunctionSummary>();
  for (const functionDeclaration of facts.keys()) {
    const reached = reach(functionDeclaration, facts);
    const reachOutsideNames = new Set<string>();
    for (const reachedFunction of reached) {
      for (const name of factsOf(facts, reachedFunction).outsideNames) reachOutsideNames.add(name);
    }
    summaries.set(functionDeclaration, { asynchronous: asynchronous.has(functionDeclaration), contained: isContained(reached, facts), reachOutsideNames });
  }
  return summaries;
}
