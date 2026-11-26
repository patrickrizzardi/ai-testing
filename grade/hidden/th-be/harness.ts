// Shared harness for the TH-BE hidden tests: loads `run` from the solution,
// provides a virtual clock (sleep advances virtual time, never real time) and
// a position marker so expected line/column are never counted by hand.
import { expect } from "bun:test";
import { join } from "node:path";

export type Value = null | boolean | number | string | Value[] | { [field: string]: Value };
export type IoTable = Record<string, { value: Value; latencyMs: number }>;
export type RunError = { kind: "SyntaxError" | "RuntimeError"; message: string; line: number; column: number };
export type RunResult = { output: string[]; error: null | RunError; heap: { allocs: number; frees: number } };
type Clock = { now(): number; sleep(ms: number): Promise<void> };
type RunFunction = (source: string, options: { clock: Clock; io?: IoTable }) => Promise<RunResult>;

const solutionDirectory = process.env.SOLUTION_DIR;
if (!solutionDirectory) throw new Error("SOLUTION_DIR is not set");
const solutionModule = (await import(join(solutionDirectory, "src/index.ts"))) as { run: RunFunction };
const run = solutionModule.run;

export type SleepCall = { startedAt: number; ms: number };

/**
 * A clock whose time moves only when every runnable continuation has run:
 * each `sleep` registers a timer; one `setImmediate` turn later (after all
 * pending microtasks) the earliest timer fires and virtual time jumps to it.
 * Ties fire in the order the sleeps were requested.
 */
export function createVirtualClock() {
  let currentTime = 0;
  let nextSequence = 0;
  let pumpScheduled = false;
  const timers: { wakeAt: number; sequence: number; wake: () => void }[] = [];
  const sleepCalls: SleepCall[] = [];

  function pump(): void {
    pumpScheduled = false;
    timers.sort((left, right) => left.wakeAt - right.wakeAt || left.sequence - right.sequence);
    const earliest = timers.shift();
    if (!earliest) return;
    currentTime = earliest.wakeAt;
    earliest.wake();
    schedulePump();
  }
  function schedulePump(): void {
    if (pumpScheduled || timers.length === 0) return;
    pumpScheduled = true;
    setImmediate(pump);
  }
  const clock: Clock = {
    now: () => currentTime,
    sleep(ms: number): Promise<void> {
      if (!Number.isInteger(ms) || ms < 0) throw new Error(`clock.sleep called with ${String(ms)}`);
      sleepCalls.push({ startedAt: currentTime, ms });
      return new Promise<void>((resolve) => {
        timers.push({ wakeAt: currentTime + ms, sequence: nextSequence++, wake: resolve });
        schedulePump();
      });
    },
  };
  return { clock, sleepCalls };
}

export type Outcome = RunResult & { elapsed: number; sleepCalls: SleepCall[] };

/** Runs `source` on a fresh virtual clock and returns the result with the elapsed virtual time. */
export async function exec(source: string, io?: IoTable): Promise<Outcome> {
  const { clock, sleepCalls } = createVirtualClock();
  const ioBefore = io === undefined ? undefined : JSON.stringify(io);
  const options = io === undefined ? { clock } : { clock, io };
  const result = await run(source, options);
  if (io !== undefined && JSON.stringify(io) !== ioBefore) throw new Error("run modified options.io");
  if (result.error !== null && !(typeof result.error.message === "string" && result.error.message.length > 0)) {
    throw new Error("error.message must be a non-empty string");
  }
  return { ...result, elapsed: clock.now(), sleepCalls };
}

/** Runs with a clock whose sleep rejects; resolves to what `run` settled with. */
export function execWithRejectingClock(source: string, reason: Error, io?: IoTable): Promise<RunResult> {
  const clock: Clock = { now: () => 0, sleep: () => Promise.reject(reason) };
  return run(source, io === undefined ? { clock } : { clock, io });
}

export const MARK = "⟦";

export type Located = { source: string; line: number; column: number };

/** `at("let x = ⟦;")` → the source without the marker and the 1-based position the marker stood at. */
export function at(template: string): Located {
  const markIndex = template.indexOf(MARK);
  if (markIndex < 0 || template.indexOf(MARK, markIndex + 1) >= 0) throw new Error("template needs exactly one marker");
  const before = template.slice(0, markIndex);
  const line = before.split("\n").length;
  const column = before.length - (before.lastIndexOf("\n") + 1) + 1;
  return { source: before + template.slice(markIndex + MARK.length), line, column };
}

export function errorPosition(outcome: RunResult): { kind: string; line: number; column: number } | null {
  if (outcome.error === null) return null;
  return { kind: outcome.error.kind, line: outcome.error.line, column: outcome.error.column };
}

/** A program that must fail before running, with a SyntaxError at the marker. */
export async function expectSyntaxErrorAt(template: string): Promise<void> {
  const located = at(template);
  const outcome = await exec(located.source);
  expect(errorPosition(outcome)).toEqual({ kind: "SyntaxError", line: located.line, column: located.column });
  expect(outcome.output).toEqual([]);
  expect(outcome.heap).toEqual({ allocs: 0, frees: 0 });
  expect(outcome.sleepCalls).toEqual([]);
}

/** A program that must stop with a RuntimeError at the marker; returns the outcome for further asserts. */
export async function expectRuntimeErrorAt(template: string, io?: IoTable): Promise<Outcome> {
  const located = at(template);
  const outcome = await exec(located.source, io);
  expect(errorPosition(outcome)).toEqual({ kind: "RuntimeError", line: located.line, column: located.column });
  expect(outcome.heap.frees).toBe(outcome.heap.allocs);
  return outcome;
}

/** A program that must finish; returns the outcome for further asserts. */
export async function expectOk(source: string, io?: IoTable): Promise<Outcome> {
  const outcome = await exec(source, io);
  expect(outcome.error).toBeNull();
  expect(outcome.heap.frees).toBe(outcome.heap.allocs);
  return outcome;
}

export const ZERO_HEAP = { allocs: 0, frees: 0 };

/** `slow` of spec section 12.5 on one line, so a program using it keeps its own line numbers from line 2. */
export const SLOW = 'fn slow(label, ms) { sleep(ms); print(label); return ms; }\n';
