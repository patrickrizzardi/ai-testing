import type { Analysis, Step } from "../analysis";
import type { SourcePosition } from "../errors";
import { MAXIMUM_CALL_DEPTH } from "../language/builtin-names";
import type { Binary, Block, Call, Expression, ForStatement, Identifier, Program, Statement } from "../syntax/ast";
import { BUILTIN_ARITY, callBuiltin, type BuiltinEnvironment } from "./builtins";
import { executeConcurrentRun, type RunHost } from "./concurrent-run";
import { failAt } from "./failure";
import type { Heap } from "./heap";
import { applyBinary, applyUnary } from "./operators";
import { createScope, scopeAbove, UNINITIALIZED, type Scope } from "./scope";
import type { Strand } from "./strand";
import type { Evaluation } from "./suspension";
import { expectArray, expectBoolean, expectIndexWithin, expectRecord } from "./typecheck";
import { Closure, type RuntimeValue } from "./values";

/** How a statement list ended: by a `return` carrying its value, or normally (null). */
type Completion = { readonly returned: RuntimeValue } | null;

type LoopBinding = { readonly slot: number; readonly value: RuntimeValue };

function elementAt(items: readonly RuntimeValue[], index: number): RuntimeValue {
  const element = items[index];
  if (element === undefined) throw new Error(`array element ${index} is missing after a bounds check`);
  return element;
}

/**
 * Executes an analysed program. Statements and expressions are evaluations (generators) so that a
 * strand runs without interruption until it waits on the clock. Every value held across another
 * evaluation is held on the strand's root stack, which is what the heap collects against.
 */
export class Evaluator implements RunHost {
  constructor(
    private readonly analysis: Analysis,
    private readonly environment: BuiltinEnvironment,
  ) {}

  get heap(): Heap {
    return this.environment.heap;
  }

  /** Executes the steps of `statementList` in `scope`, stopping at the first `return`. */
  *runStatementList(statementList: Program | Block, scope: Scope, strand: Strand): Evaluation<Completion> {
    for (const step of this.analysis.stepsOf(statementList)) {
      this.environment.heap.collectIfDue();
      const completion = yield* this.executeStep(step, scope, strand);
      if (completion !== null) return completion;
    }
    return null;
  }

  private *executeStep(step: Step, scope: Scope, strand: Strand): Evaluation<Completion> {
    if (step.kind === "concurrentRun") {
      yield* executeConcurrentRun(this, step.members, scope, strand);
      return null;
    }
    return yield* this.executeStatement(step.statement, scope, strand);
  }

  private *executeStatement(statement: Statement, scope: Scope, strand: Strand): Evaluation<Completion> {
    switch (statement.kind) {
      case "Let": {
        const value = yield* this.evaluate(statement.initializer, scope, strand);
        scope.slots[this.analysis.declarationOf(statement).slot] = value;
        return null;
      }
      case "Expression":
        yield* this.evaluate(statement.expression, scope, strand);
        return null;
      case "Assign":
        yield* this.executeAssignment(statement.target, statement.value, scope, strand);
        return null;
      case "If": {
        const condition = yield* this.evaluate(statement.condition, scope, strand);
        if (expectBoolean(condition, statement.condition.first, "an if condition")) return yield* this.executeBlock(statement.thenBlock, scope, strand, null);
        if (statement.elseBranch === null) return null;
        return statement.elseBranch.kind === "Block"
          ? yield* this.executeBlock(statement.elseBranch, scope, strand, null)
          : yield* this.executeStatement(statement.elseBranch, scope, strand);
      }
      case "While":
        return yield* this.executeWhile(statement.condition, statement.body, scope, strand);
      case "For":
        return yield* this.executeFor(statement, scope, strand);
      case "Function":
        return null;
      case "Return": {
        const value = statement.value === null ? null : yield* this.evaluate(statement.value, scope, strand);
        return { returned: value };
      }
    }
  }

  private *executeWhile(condition: Expression, body: Block, scope: Scope, strand: Strand): Evaluation<Completion> {
    for (;;) {
      const holds = yield* this.evaluate(condition, scope, strand);
      if (!expectBoolean(holds, condition.first, "a while condition")) return null;
      const completion = yield* this.executeBlock(body, scope, strand, null);
      if (completion !== null) return completion;
    }
  }

  private *executeFor(statement: ForStatement, scope: Scope, strand: Strand): Evaluation<Completion> {
    const iterable = yield* this.evaluate(statement.iterable, scope, strand);
    const array = expectArray(iterable, statement.iterable.first, "the iterable of for");
    const slot = this.analysis.declarationOf(statement).slot;
    const mark = strand.roots.mark();
    strand.roots.push(array);
    for (let index = 0; index < array.items.length; index += 1) {
      const completion = yield* this.executeBlock(statement.body, scope, strand, { slot, value: elementAt(array.items, index) });
      if (completion !== null) {
        strand.roots.popTo(mark);
        return completion;
      }
    }
    strand.roots.popTo(mark);
    return null;
  }

  /** Runs `block` in a fresh scope below `scope`; `loopBinding` initializes a `for` variable. */
  private *executeBlock(block: Block, scope: Scope, strand: Strand, loopBinding: LoopBinding | null): Evaluation<Completion> {
    const blockScope = createScope(this.analysis.scopeOf(block), scope);
    if (loopBinding !== null) blockScope.slots[loopBinding.slot] = loopBinding.value;
    const mark = strand.roots.mark();
    strand.roots.push(blockScope);
    const completion = yield* this.runStatementList(block, blockScope, strand);
    strand.roots.popTo(mark);
    return completion;
  }

  private *executeAssignment(target: Expression, valueExpression: Expression, scope: Scope, strand: Strand): Evaluation<void> {
    const mark = strand.roots.mark();
    if (target.kind === "Identifier") {
      this.store(target, yield* this.evaluate(valueExpression, scope, strand), scope);
    } else if (target.kind === "Index") {
      const base = yield* this.evaluateHeld(target.target, scope, strand);
      const index = yield* this.evaluateHeld(target.index, scope, strand);
      const value = yield* this.evaluate(valueExpression, scope, strand);
      const array = expectArray(base, target.openBracket, "the target of an index assignment");
      array.items[expectIndexWithin(index, array.items.length, target.openBracket)] = value;
    } else if (target.kind === "Field") {
      const base = yield* this.evaluateHeld(target.target, scope, strand);
      const value = yield* this.evaluate(valueExpression, scope, strand);
      expectRecord(base, target.dot, "the target of a field assignment").fields.set(target.name, value);
    } else {
      throw new Error(`assignment target ${target.kind} should have been rejected by static analysis`);
    }
    strand.roots.popTo(mark);
  }

  /** Evaluates `expression` and holds its value on the strand's roots until the caller pops. */
  private *evaluateHeld(expression: Expression, scope: Scope, strand: Strand): Evaluation<RuntimeValue> {
    const value = yield* this.evaluate(expression, scope, strand);
    strand.roots.push(value);
    return value;
  }

  private *evaluateAllHeld(expressions: readonly Expression[], scope: Scope, strand: Strand): Evaluation<RuntimeValue[]> {
    const values: RuntimeValue[] = [];
    for (const expression of expressions) values.push(yield* this.evaluateHeld(expression, scope, strand));
    return values;
  }

  *evaluate(expression: Expression, scope: Scope, strand: Strand): Evaluation<RuntimeValue> {
    switch (expression.kind) {
      case "IntegerLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
        return expression.value;
      case "NilLiteral":
        return null;
      case "Identifier":
        return this.read(expression, scope);
      case "Group":
        return yield* this.evaluate(expression.inner, scope, strand);
      case "ArrayLiteral": {
        const mark = strand.roots.mark();
        const elements = yield* this.evaluateAllHeld(expression.elements, scope, strand);
        strand.roots.popTo(mark);
        return this.environment.heap.createArray(elements);
      }
      case "RecordLiteral": {
        const mark = strand.roots.mark();
        const values = yield* this.evaluateAllHeld(
          expression.fields.map((field) => field.value),
          scope,
          strand,
        );
        strand.roots.popTo(mark);
        return this.environment.heap.createRecord(new Map(expression.fields.map((field, position) => [field.name, elementAt(values, position)])));
      }
      case "Unary":
        return applyUnary(expression.operator, yield* this.evaluate(expression.operand, scope, strand), expression.operatorToken);
      case "Binary":
        return yield* this.evaluateBinary(expression, scope, strand);
      case "Call":
        return yield* this.evaluateCall(expression, scope, strand);
      case "Index": {
        const mark = strand.roots.mark();
        const target = yield* this.evaluateHeld(expression.target, scope, strand);
        const index = yield* this.evaluate(expression.index, scope, strand);
        strand.roots.popTo(mark);
        const array = expectArray(target, expression.openBracket, "an indexed value");
        return elementAt(array.items, expectIndexWithin(index, array.items.length, expression.openBracket));
      }
      case "Field": {
        const record = expectRecord(yield* this.evaluate(expression.target, scope, strand), expression.dot, "a value with a field");
        const value = record.fields.get(expression.name);
        if (value === undefined) failAt(expression.dot, `the record has no field '${expression.name}'`);
        return value;
      }
    }
  }

  private *evaluateBinary(expression: Binary, scope: Scope, strand: Strand): Evaluation<RuntimeValue> {
    const mark = strand.roots.mark();
    const left = yield* this.evaluate(expression.left, scope, strand);
    if (expression.operator === "&&" || expression.operator === "||") {
      const isAnd = expression.operator === "&&";
      const decided = expectBoolean(left, expression.operatorToken, `the left operand of '${expression.operator}'`);
      if (decided !== isAnd) return decided;
      return expectBoolean(yield* this.evaluate(expression.right, scope, strand), expression.operatorToken, `the right operand of '${expression.operator}'`);
    }
    strand.roots.push(left);
    const right = yield* this.evaluate(expression.right, scope, strand);
    strand.roots.popTo(mark);
    return applyBinary(expression.operator, left, right, expression.operatorToken);
  }

  private *evaluateCall(call: Call, scope: Scope, strand: Strand): Evaluation<RuntimeValue> {
    const mark = strand.roots.mark();
    const callee = yield* this.evaluateHeld(call.callee, scope, strand);
    const argumentValues = yield* this.evaluateAllHeld(call.argumentExpressions, scope, strand);
    const result = yield* this.invoke(callee, argumentValues, call.openParenthesis, strand);
    strand.roots.popTo(mark);
    return result;
  }

  /** The call rules of spec 6.3 and 7 for an already evaluated callee and arguments. */
  *invoke(callee: RuntimeValue, argumentValues: readonly RuntimeValue[], openParenthesis: SourcePosition, strand: Strand): Evaluation<RuntimeValue> {
    if (callee instanceof Closure) {
      this.checkArgumentCount(callee.declaration.parameters.length, argumentValues, openParenthesis);
      return yield* this.runClosure(callee, argumentValues, openParenthesis, strand);
    }
    if (typeof callee === "object" && callee !== null && callee.kind === "builtin") {
      this.checkArgumentCount(BUILTIN_ARITY[callee.name], argumentValues, openParenthesis);
      return yield* callBuiltin(callee.name, { environment: this.environment, strand, argumentValues, position: openParenthesis });
    }
    return failAt(openParenthesis, "only functions can be called");
  }

  private checkArgumentCount(expectedCount: number, argumentValues: readonly RuntimeValue[], openParenthesis: SourcePosition): void {
    if (argumentValues.length !== expectedCount) failAt(openParenthesis, `expected ${expectedCount} arguments, got ${argumentValues.length}`);
  }

  /** Calls a user function: depth check, a scope with the parameters bound, then the body. */
  private *runClosure(closure: Closure, argumentValues: readonly RuntimeValue[], openParenthesis: SourcePosition, strand: Strand): Evaluation<RuntimeValue> {
    if (strand.depth + 1 > MAXIMUM_CALL_DEPTH) failAt(openParenthesis, `call depth exceeds ${MAXIMUM_CALL_DEPTH}`);
    const scope = createScope(this.analysis.scopeOf(closure.declaration), closure.scope);
    argumentValues.forEach((argument, position) => {
      scope.slots[position] = argument;
    });
    const mark = strand.roots.mark();
    strand.roots.push(scope);
    strand.depth += 1;
    const completion = yield* this.runStatementList(closure.declaration.body, scope, strand);
    strand.depth -= 1;
    strand.roots.popTo(mark);
    return completion === null ? null : completion.returned;
  }

  private read(identifier: Identifier, scope: Scope): RuntimeValue {
    const { holder, slot } = this.locate(identifier, scope);
    const value = holder.slots[slot];
    if (value === undefined) throw new Error(`slot ${slot} of the scope for ${identifier.name} does not exist`);
    if (value === UNINITIALIZED) failAt(identifier.token, `'${identifier.name}' is used before it is initialized`);
    return value;
  }

  private store(identifier: Identifier, value: RuntimeValue, scope: Scope): void {
    const { holder, slot } = this.locate(identifier, scope);
    if (holder.slots[slot] === UNINITIALIZED) failAt(identifier.token, `'${identifier.name}' is assigned before it is initialized`);
    holder.slots[slot] = value;
  }

  /** The scope and cell an identifier refers to; an unresolved name is a runtime error (spec 4.1). */
  private locate(identifier: Identifier, scope: Scope): { holder: Scope; slot: number } {
    const resolution = this.analysis.resolutionOf(identifier);
    if (resolution === null) failAt(identifier.token, `'${identifier.name}' is not defined`);
    return { holder: scopeAbove(scope, resolution.hops), slot: resolution.declaration.slot };
  }
}
