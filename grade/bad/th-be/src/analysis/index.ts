import { fail, succeed, type Result } from "../errors";
import { requireEntry } from "../invariants";
import type { Block, FunctionDeclaration, Identifier, Program } from "../syntax/ast";
import { collectFunctions } from "../syntax/walk";
import { collectFunctionFacts } from "./function-facts";
import { summarizeFunctions } from "./function-summaries";
import type { Analysis, Declaration, DeclarationSite, Resolution, ScopeInfo, ScopeOwner, Step } from "./model";
import { resolutionIn, resolveProgram, type ResolvedProgram } from "./resolver";
import { planRuns } from "./runs";

export type { Analysis, Declaration, RunMember, ScopeInfo, Step } from "./model";

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
    scopeOf: (owner: ScopeOwner): ScopeInfo => requireEntry(resolved.scopeInfos, owner, "scope for the node"),
    resolutionOf: (identifier: Identifier): Resolution | null => resolutionIn(resolved.resolutions, identifier),
    declarationOf: (site: DeclarationSite): Declaration => requireEntry(resolved.declarations, site, "declaration for the node"),
    stepsOf: (statementList: Program | Block): readonly Step[] => requireEntry(steps, statementList, "steps for the statement list"),
  };
}
