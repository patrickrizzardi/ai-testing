import { fail, succeed, type Result } from "../errors";
import type { Block, FunctionDeclaration, Identifier, Program } from "../syntax/ast";
import { collectFunctions } from "../syntax/walk";
import { collectFunctionFacts } from "./function-facts";
import { summarizeFunctions } from "./function-summaries";
import type { Analysis, Declaration, DeclarationSite, Resolution, ScopeInfo, ScopeOwner, Step } from "./model";
import { resolveProgram, type ResolvedProgram } from "./resolver";
import { planRuns } from "./runs";

export type { Analysis, Declaration, RunMember, ScopeInfo, Step } from "./model";

function lookup<Key, Found>(table: ReadonlyMap<Key, Found>, key: Key, what: string): Found {
  const found = table.get(key);
  if (found === undefined) throw new Error(`analysis has no ${what}`);
  return found;
}

/**
 * Static analysis of a parsed program: scopes and resolution with the static errors of spec 4.2,
 * then the concurrency plan of sections 8 and 9.1-9.2. Everything is computed once, here.
 */
export function analyze(program: Program): Result<Analysis> {
  const resolved = resolveProgram(program);
  if (!resolved.ok) return fail(resolved.error);
  const functions: FunctionDeclaration[] = collectFunctions(program.statements);
  const summaries = summarizeFunctions(collectFunctionFacts(functions, resolved.value));
  return succeed(createAnalysis(resolved.value, planRuns(program, resolved.value, summaries)));
}

function createAnalysis(resolved: ResolvedProgram, steps: ReadonlyMap<Program | Block, readonly Step[]>): Analysis {
  return {
    builtinScope: resolved.builtinScope,
    scopeOf: (owner: ScopeOwner): ScopeInfo => lookup(resolved.scopeInfos, owner, "scope for the node"),
    resolutionOf: (identifier: Identifier): Resolution | null => {
      const resolution = resolved.resolutions.get(identifier);
      if (resolution === undefined) throw new Error(`analysis did not visit identifier ${identifier.name}`);
      return resolution;
    },
    declarationOf: (site: DeclarationSite): Declaration => lookup(resolved.declarations, site, "declaration for the node"),
    stepsOf: (statementList: Program | Block): readonly Step[] => lookup(steps, statementList, "steps for the statement list"),
  };
}
