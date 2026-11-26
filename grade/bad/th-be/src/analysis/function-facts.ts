import { ASYNCHRONOUS_BUILTINS, MUTATING_BUILTIN } from "../language/builtin-names";
import type { Call, Expression, FunctionDeclaration, Identifier } from "../syntax/ast";
import { ownExpressions, visitExpression, visitStatements } from "../syntax/walk";
import { calleeDeclarationOf, resolutionIn, type ResolvedProgram } from "./resolver";

/** What the rules of spec section 8 need to know about one function body (nested function bodies excluded). */
export type FunctionFacts = {
  readonly calledFunctions: ReadonlySet<FunctionDeclaration>;
  /** True when the body calls `sleep` or `fetch` by name. */
  readonly callsAsynchronousBuiltin: boolean;
  readonly hasOpaqueCall: boolean;
  readonly assignsNonLocalVariable: boolean;
  readonly hasMutation: boolean;
  /** A mutation without a root, or whose root is not a local variable. */
  readonly hasUnsafeMutation: boolean;
  readonly hasNonLocalVariableOccurrence: boolean;
  /** Names of occurrences that resolve outside the function or not at all, builtins excluded (spec 9.2). */
  readonly outsideNames: ReadonlySet<string>;
};

/** The leftmost identifier of `target` when it is an identifier followed only by index and field suffixes. */
function mutationRoot(target: Expression): Identifier | null {
  let expression = target;
  while (expression.kind === "Index" || expression.kind === "Field") expression = expression.target;
  return expression.kind === "Identifier" ? expression : null;
}

class FactCollector {
  private readonly calledFunctions = new Set<FunctionDeclaration>();
  private readonly outsideNames = new Set<string>();
  private callsAsynchronousBuiltin = false;
  private hasOpaqueCall = false;
  private assignsNonLocalVariable = false;
  private hasMutation = false;
  private hasUnsafeMutation = false;
  private hasNonLocalVariableOccurrence = false;

  constructor(
    private readonly functionDeclaration: FunctionDeclaration,
    private readonly program: ResolvedProgram,
  ) {}

  collect(): FunctionFacts {
    visitStatements(
      this.functionDeclaration.body.statements,
      (statement) => {
        for (const expression of ownExpressions(statement)) visitExpression(expression, (visited) => this.observeExpression(visited));
        if (statement.kind === "Assign") this.observeAssignment(statement.target);
      },
      false,
    );
    return {
      calledFunctions: this.calledFunctions,
      callsAsynchronousBuiltin: this.callsAsynchronousBuiltin,
      hasOpaqueCall: this.hasOpaqueCall,
      assignsNonLocalVariable: this.assignsNonLocalVariable,
      hasMutation: this.hasMutation,
      hasUnsafeMutation: this.hasUnsafeMutation,
      hasNonLocalVariableOccurrence: this.hasNonLocalVariableOccurrence,
      outsideNames: this.outsideNames,
    };
  }

  /** True when `identifier` resolves to a variable declared in this function's own scopes. */
  private isLocalVariable(identifier: Identifier): boolean {
    const declaration = resolutionIn(this.program.resolutions, identifier)?.declaration;
    return declaration !== undefined && declaration.kind === "variable" && declaration.owner === this.functionDeclaration;
  }

  private observeExpression(expression: Expression): void {
    if (expression.kind === "Identifier") this.observeOccurrence(expression);
    else if (expression.kind === "Call") this.observeCall(expression);
  }

  private observeOccurrence(identifier: Identifier): void {
    const resolution = resolutionIn(this.program.resolutions, identifier);
    if (resolution === null) {
      this.outsideNames.add(identifier.name);
      this.hasNonLocalVariableOccurrence = true;
      return;
    }
    const { declaration } = resolution;
    if (declaration.kind === "builtin" || declaration.owner === this.functionDeclaration) return;
    this.outsideNames.add(identifier.name);
    if (declaration.kind === "variable") this.hasNonLocalVariableOccurrence = true;
  }

  private observeCall(call: Call): void {
    const declaration = calleeDeclarationOf(this.program.resolutions, call);
    if (declaration === null || declaration.kind === "variable") {
      this.hasOpaqueCall = true;
    } else if (declaration.declaredFunction !== null) {
      this.calledFunctions.add(declaration.declaredFunction);
    } else {
      if (ASYNCHRONOUS_BUILTINS.has(declaration.name)) this.callsAsynchronousBuiltin = true;
      if (declaration.name === MUTATING_BUILTIN) this.recordMutation(call.argumentExpressions[0] === undefined ? null : mutationRoot(call.argumentExpressions[0]));
    }
  }

  private observeAssignment(target: Expression): void {
    if (target.kind === "Identifier") {
      if (!this.isLocalVariable(target)) this.assignsNonLocalVariable = true;
    } else if (target.kind === "Index") {
      this.recordMutation(mutationRoot(target));
    }
  }

  private recordMutation(root: Identifier | null): void {
    this.hasMutation = true;
    if (root === null || !this.isLocalVariable(root)) this.hasUnsafeMutation = true;
  }
}

/** Facts of every function in `functions`. O(total size of the function bodies). */
export function collectFunctionFacts(functions: readonly FunctionDeclaration[], program: ResolvedProgram): Map<FunctionDeclaration, FunctionFacts> {
  return new Map(functions.map((functionDeclaration) => [functionDeclaration, new FactCollector(functionDeclaration, program).collect()]));
}
