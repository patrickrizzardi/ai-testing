import { describe, expect, test } from "bun:test";
import { analysisOf } from "../test-support";
import { Heap } from "./heap";
import { createBuiltinScope, createScope } from "./scope";
import { Closure, type RuntimeValue } from "./values";

function createProgramScope(source: string) {
  const { program, analysis } = analysisOf(source);
  return { analysis, program, scope: createScope(analysis.scopeOf(program), createBuiltinScope(analysis.builtinScope)) };
}

describe("Heap collection (spec 10)", () => {
  test("creating counts allocations; nothing is freed until a collection", () => {
    const heap = new Heap();
    heap.createArray([]);
    heap.createRecord(new Map());
    expect(heap.counts).toEqual({ allocs: 2, frees: 0 });
  });

  test("a collection frees exactly the objects no root reaches, each once", () => {
    const heap = new Heap();
    const stack = heap.openRootStack();
    const kept = heap.createArray([heap.createRecord(new Map<string, RuntimeValue>([["inner", heap.createArray([])]]))]);
    heap.createArray([kept]);
    stack.push(kept);
    heap.collect();
    expect(heap.counts).toEqual({ allocs: 4, frees: 1 });
    heap.collect();
    expect(heap.counts).toEqual({ allocs: 4, frees: 1 });
    stack.popTo(0);
    heap.collect();
    expect(heap.counts).toEqual({ allocs: 4, frees: 4 });
  });

  test("an object held by two stacks survives until both release it", () => {
    const heap = new Heap();
    const first = heap.openRootStack();
    const second = heap.openRootStack();
    const shared = heap.createArray([]);
    first.push(shared);
    second.push(shared);
    first.popTo(0);
    heap.collect();
    expect(heap.counts.frees).toBe(0);
    heap.closeRootStack(second);
    heap.collect();
    expect(heap.counts.frees).toBe(1);
  });

  test("remove releases the topmost holding only, so a leaked holding keeps the object alive", () => {
    const heap = new Heap();
    const stack = heap.openRootStack();
    const object = heap.createArray([]);
    stack.push(object);
    stack.push(object);
    stack.remove(object);
    heap.collect();
    expect(heap.counts.frees).toBe(0);
    stack.remove(object);
    heap.collect();
    expect(heap.counts.frees).toBe(1);
  });

  test("a scope reaches its variables and its parents; a closure reaches the scope it captured", () => {
    const { analysis, program, scope } = createProgramScope("fn make() { let kept = 1; fn inner() { } }\nlet slot = 1;");
    const heap = new Heap();
    const stack = heap.openRootStack();
    const slotDeclaration = analysis.scopeOf(program).declarations.find((declaration) => declaration.name === "slot");
    if (slotDeclaration === undefined) throw new Error("no slot declaration");
    const closure = scope.slots.find((value): value is Closure => value instanceof Closure);
    if (closure === undefined) throw new Error("no hoisted closure");
    scope.slots[slotDeclaration.slot] = heap.createArray([]);
    stack.push(closure);
    heap.collect();
    expect(heap.counts.frees).toBe(0);
    stack.popTo(0);
    heap.collect();
    expect(heap.counts.frees).toBe(1);
  });

  test("an unrooted scope and its hoisted closure, which reach each other, are collected with what the scope holds", () => {
    const { program, scope, analysis } = createProgramScope("fn cycle() { }\nlet held = 1;");
    const heap = new Heap();
    const held = analysis.scopeOf(program).declarations.find((declaration) => declaration.name === "held");
    if (held === undefined) throw new Error("no declaration");
    scope.slots[held.slot] = heap.createArray([]);
    heap.collect();
    expect(heap.counts).toEqual({ allocs: 1, frees: 1 });
  });

  test("collectIfDue waits for the interval and then collects", () => {
    const heap = new Heap();
    for (let created = 0; created < 1000; created += 1) heap.createArray([]);
    heap.collectIfDue();
    expect(heap.counts.frees).toBe(0);
    for (let created = 0; created < 100; created += 1) heap.createArray([]);
    heap.collectIfDue();
    expect(heap.counts).toEqual({ allocs: 1100, frees: 1100 });
  });

  test("a deeply nested value is traced without recursion", () => {
    const heap = new Heap();
    const stack = heap.openRootStack();
    let nested: RuntimeValue = heap.createArray([]);
    for (let depth = 0; depth < 200000; depth += 1) nested = heap.createArray([nested]);
    stack.push(nested);
    heap.collect();
    expect(heap.counts.frees).toBe(0);
  });
});
