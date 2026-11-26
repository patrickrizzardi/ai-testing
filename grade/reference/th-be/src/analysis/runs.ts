import type { Block, Call, Expression, FunctionDeclaration, LetStatement, Program, Statement } from "../syntax/ast";
import { containsCall, nestedBlocks, visitExpression, visitStatements } from "../syntax/walk";
import type { FunctionSummary } from "./function-summaries";
import type { RunMember, Step } from "./model";
import type { ResolvedProgram } from "./resolver";

type StatementList = { readonly owner: Program | Block; readonly statements: readonly Statement[] };

function namesIn(expression: Expression): Set<string> {
  const names = new Set<string>();
  visitExpression(expression, (visited) => {
    if (visited.kind === "Identifier") names.add(visited.name);
  });
  return names;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const name of left) {
    if (right.has(name)) return true;
  }
  return false;
}

/** The names a member defines and uses (spec 9.2). */
type MemberNames = { readonly defines: ReadonlySet<string>; readonly uses: ReadonlySet<string> };

class RunPlanner {
  constructor(
    private readonly program: ResolvedProgram,
    private readonly summaries: ReadonlyMap<FunctionDeclaration, FunctionSummary>,
  ) {}

  /** Splits one statement list into single steps and independent concurrent runs. O(statements + names of the runs). */
  plan(statements: readonly Statement[]): Step[] {
    const steps: Step[] = [];
    let run: RunMember[] = [];
    const endRun = (): void => {
      if (run.length >= 2 && this.areIndependent(run)) steps.push({ kind: "concurrentRun", members: run });
      else steps.push(...run.map((member): Step => ({ kind: "single", statement: member.statement })));
      run = [];
    };
    for (const statement of statements) {
      const member = this.candidateOf(statement);
      if (member === null) {
        endRun();
        steps.push({ kind: "single", statement });
      } else {
        run.push(member);
      }
    }
    endRun();
    return steps;
  }

  /** The statement as a run member when it is a candidate of spec 9.1, otherwise null. */
  private candidateOf(statement: Statement): RunMember | null {
    if (statement.kind !== "Let" && statement.kind !== "Expression") return null;
    if (statement.waits) return null;
    const expression = statement.kind === "Let" ? statement.initializer : statement.expression;
    if (expression.kind !== "Call" || expression.argumentExpressions.some(containsCall) || !this.isConcurrentCallee(expression)) return null;
    return { statement, call: expression, binding: statement.kind === "Let" ? this.declarationOfLet(statement) : null };
  }

  private declarationOfLet(statement: LetStatement): RunMember["binding"] {
    const declaration = this.program.declarations.get(statement);
    if (declaration === undefined) throw new Error(`let ${statement.name} has no declaration`);
    return declaration;
  }

  /** `sleep`, `fetch`, or an asynchronous contained function, called by name. */
  private isConcurrentCallee(call: Call): boolean {
    if (call.callee.kind !== "Identifier") return false;
    const declaration = this.program.resolutions.get(call.callee)?.declaration;
    if (declaration === undefined) return false;
    if (declaration.kind === "builtin") return declaration.name === "sleep" || declaration.name === "fetch";
    if (declaration.declaredFunction === null) return false;
    const summary = this.summaries.get(declaration.declaredFunction);
    return summary !== undefined && summary.asynchronous && summary.contained;
  }

  private namesOf(member: RunMember): MemberNames {
    const uses = namesIn(member.call);
    const callee = member.call.callee.kind === "Identifier" ? this.program.resolutions.get(member.call.callee)?.declaration.declaredFunction : null;
    const summary = callee === null || callee === undefined ? undefined : this.summaries.get(callee);
    for (const name of summary?.reachOutsideNames ?? []) uses.add(name);
    return { defines: new Set(member.binding === null ? [] : [member.binding.name]), uses };
  }

  /** Pairwise independence of spec 9.2. O(members^2 * names). */
  private areIndependent(members: readonly RunMember[]): boolean {
    const names = members.map((member) => this.namesOf(member));
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const first = names[i];
        const second = names[j];
        if (first === undefined || second === undefined) throw new Error("member names are missing");
        if (intersects(first.defines, second.defines) || intersects(first.defines, second.uses) || intersects(second.defines, first.uses)) return false;
      }
    }
    return true;
  }
}

/** Every statement list of the program: the program's own and those of all blocks, function bodies included. */
function collectStatementLists(program: Program): StatementList[] {
  const lists: StatementList[] = [{ owner: program, statements: program.statements }];
  visitStatements(
    program.statements,
    (statement) => {
      for (const block of nestedBlocks(statement)) lists.push({ owner: block, statements: block.statements });
    },
    true,
  );
  return lists;
}

/** The execution steps of every statement list (spec 9.1, 9.2). O(program size + names of the runs). */
export function planRuns(program: Program, resolved: ResolvedProgram, summaries: ReadonlyMap<FunctionDeclaration, FunctionSummary>): Map<Program | Block, readonly Step[]> {
  const planner = new RunPlanner(resolved, summaries);
  return new Map(collectStatementLists(program).map(({ owner, statements }) => [owner, planner.plan(statements)]));
}
