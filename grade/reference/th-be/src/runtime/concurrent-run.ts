import type { RunMember } from "../analysis";
import type { SourcePosition } from "../errors";
import type { Expression } from "../syntax/ast";
import { RuntimeFailure } from "./failure";
import type { Heap } from "./heap";
import type { Scope } from "./scope";
import { closeStrand, openStrand, type Strand } from "./strand";
import { awaitPromise, drive, type Evaluation } from "./suspension";
import { isHeapValue, type RuntimeValue } from "./values";

/** What a concurrent run needs from the evaluator that executes it. */
export type RunHost = {
  readonly heap: Heap;
  evaluate(expression: Expression, scope: Scope, strand: Strand): Evaluation<RuntimeValue>;
  invoke(callee: RuntimeValue, argumentValues: readonly RuntimeValue[], openParenthesis: SourcePosition, strand: Strand): Evaluation<RuntimeValue>;
};

/** A member after spec 9.3 step 2: its callee, its argument values, or the failure that stopped their evaluation. */
type PreparedMember = {
  readonly member: RunMember;
  readonly callee: RuntimeValue;
  readonly argumentValues: readonly RuntimeValue[];
  readonly failure: RuntimeFailure | null;
};

/** What a member produced: its private output and either a result or a failure. */
type MemberOutcome = { readonly output: string[]; result: RuntimeValue; failure: RuntimeFailure | null };

/**
 * Spec 9.3 step 2: evaluates the callee and the arguments of `member`; an error becomes the member's
 * failure. Completed argument values are held on the strand's roots, the half-built ones are dropped.
 */
function* prepareMember(host: RunHost, member: RunMember, scope: Scope, strand: Strand): Evaluation<PreparedMember> {
  const argumentValues: RuntimeValue[] = [];
  let callee: RuntimeValue = null;
  let heldMark = strand.roots.mark();
  try {
    callee = yield* host.evaluate(member.call.callee, scope, strand);
    for (const argument of member.call.argumentExpressions) {
      const value = yield* host.evaluate(argument, scope, strand);
      strand.roots.push(value);
      heldMark = strand.roots.mark();
      argumentValues.push(value);
    }
  } catch (failure) {
    if (!(failure instanceof RuntimeFailure)) throw failure;
    strand.roots.popTo(heldMark);
    return { member, callee, argumentValues, failure };
  }
  return { member, callee, argumentValues, failure: null };
}

/** Spec 9.3 step 4 for one member: runs its call on its own strand and records the outcome. */
function* runMember(host: RunHost, prepared: PreparedMember, parent: Strand, strand: Strand, outcome: MemberOutcome): Evaluation<void> {
  try {
    outcome.result = yield* host.invoke(prepared.callee, prepared.argumentValues, prepared.member.call.openParenthesis, strand);
    // The parent is parked at the join: holding the result there keeps it alive until it is bound.
    parent.roots.push(outcome.result);
  } catch (failure) {
    if (!(failure instanceof RuntimeFailure)) throw failure;
    outcome.failure = failure;
  } finally {
    closeStrand(host.heap, strand);
  }
}

function bindResult(member: RunMember, scope: Scope, result: RuntimeValue): void {
  if (member.binding !== null) scope.slots[member.binding.slot] = result;
}

/** Spec 9.3 step 3: one member at a time, in order, with the argument values computed in step 2. */
function* runOneAtATime(host: RunHost, prepared: readonly PreparedMember[], scope: Scope, strand: Strand): Evaluation<void> {
  for (const next of prepared) {
    if (next.failure !== null) throw next.failure;
    bindResult(next.member, scope, yield* host.invoke(next.callee, next.argumentValues, next.member.call.openParenthesis, strand));
  }
}

type StartedMember = { readonly prepared: PreparedMember; readonly outcome: MemberOutcome };

/**
 * Spec 9.3 step 4 and 5: starts every member at once on its own strand, waits for all of them,
 * then appends their output in source order (up to the earliest failure) and binds their results.
 * O(members) time and memory besides the members' own work.
 */
function* runConcurrently(host: RunHost, prepared: readonly PreparedMember[], scope: Scope, strand: Strand): Evaluation<void> {
  const running: Promise<void>[] = [];
  const started = prepared.map((next): StartedMember => {
    if (next.failure !== null) return { prepared: next, outcome: { output: [], result: null, failure: next.failure } };
    const memberStrand = openStrand(host.heap, strand.depth);
    const outcome: MemberOutcome = { output: memberStrand.output, result: null, failure: null };
    running.push(drive(runMember(host, next, strand, memberStrand, outcome)));
    return { prepared: next, outcome };
  });
  const settled = yield* awaitPromise(Promise.allSettled(running));
  for (const finished of settled) {
    if (finished.status === "rejected") throw finished.reason;
  }
  const earliestFailure = started.findIndex(({ outcome }) => outcome.failure !== null);
  const reported = earliestFailure < 0 ? started : started.slice(0, earliestFailure + 1);
  for (const { outcome } of reported) {
    for (const line of outcome.output) strand.output.push(line);
  }
  for (const { outcome } of reported) {
    if (outcome.failure !== null) throw outcome.failure;
  }
  for (const { prepared: next, outcome } of started) bindResult(next.member, scope, outcome.result);
}

/**
 * Executes a run of two or more independent members (spec 9.3): arguments first, then either one
 * at a time (when an argument value is an array or record) or all at once. The argument values
 * and the results stay held on the strand's roots until the run is over.
 * O(members) time and memory besides evaluating the arguments and running the members.
 */
export function* executeConcurrentRun(host: RunHost, members: readonly RunMember[], scope: Scope, strand: Strand): Evaluation<void> {
  const mark = strand.roots.mark();
  const prepared: PreparedMember[] = [];
  for (const member of members) prepared.push(yield* prepareMember(host, member, scope, strand));
  if (prepared.some((next) => next.argumentValues.some(isHeapValue))) yield* runOneAtATime(host, prepared, scope, strand);
  else yield* runConcurrently(host, prepared, scope, strand);
  strand.roots.popTo(mark);
}
