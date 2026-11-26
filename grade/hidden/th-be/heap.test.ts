// Spec section 10: the counted heap. Creations are fixed by the spec (array
// literal 1, record literal 1, keys 1, fetch 1 per array and record in the
// value); every object is freed exactly once, and frees equals allocs when
// run returns, on success or on error. Tier: High (data integrity).
import { describe, expect, test } from "bun:test";
import { exec, expectOk, expectRuntimeErrorAt, SLOW, type IoTable } from "./harness.ts";

async function allocsOf(source: string, io?: IoTable): Promise<{ allocs: number; frees: number }> {
  const outcome = await expectOk(source, io);
  return outcome.heap;
}

describe("allocation counts the spec fixes (10)", () => {
  const counts: [string, string, number][] = [
    ["no containers at all", 'let s = "a" + "b"; let n = 1 + 2; print(s); print(n);', 0],
    ["an array literal", "let a = [1, 2];", 1],
    ["an empty array literal", "[];", 1],
    ["a record literal", "let r = {a: 1};", 1],
    ["an empty record literal", "{};", 1],
    ["nested literals: one per array and per record", "let x = [[1], [2, [3]], {a: [4], b: {c: []}}];", 8],
    ["a literal used only as an expression statement", "[1, 2, 3];", 1],
    ["a literal inside a call argument", "print([1, 2]);", 1],
    ["keys allocates the result array", "let r = {a: 1}; let k = keys(r);", 2],
    ["keys of an empty record", "keys({});", 2],
    ["keys called twice", "let r = {a: 1}; keys(r); keys(r);", 3],
    ["print of a container allocates nothing more", "let a = [1]; print(a); print(a);", 1],
    ["len, index, field, equality, display allocate nothing", "let a = [1, [2]]; let r = {k: a}; len(a); a[0]; r.k; a == a; a == r.k; print(r);", 3],
    ["push and assignment allocate nothing beyond their literals", "let a = []; push(a, 1); push(a, [2]); a[0] = [3]; let r = {}; r.f = [4];", 5],
    ["closures and scopes allocate nothing", "fn make() { let n = 1; fn get() { return n; } return get; } let g = make(); g(); g();", 0],
    ["strings are not heap objects", 'let s = "x"; let t = s + s + s; print(len(t));', 0],
    ["a literal evaluated in a loop counts per evaluation", "let i = 0; while i < 7 { let t = [i]; i = i + 1; }", 7],
    ["a for iterable is evaluated once", "for v in [1, 2, 3, 4] { let t = {k: v}; }", 5],
    ["a literal in a called function counts per call", "fn mk() { return [1]; } mk(); mk(); mk();", 3],
    ["literals in arguments of a failing-free recursion", "fn f(n, acc) { if n == 0 { return acc; } return f(n - 1, [n]); } f(5, []);", 6],
    ["the same array pushed into several containers is still one object", "let a = [1]; let b = [a, a]; let c = {x: a, y: b}; push(b, a);", 3],
    ["reassignment drops the old object but counts every creation", "let a = [1]; a = [2]; a = [3]; a = nil;", 3],
  ];
  for (const [rule, source, expectedAllocs] of counts) {
    // Catches: wrong allocation counts (miscounted literals, extra allocations for scopes/closures/strings) or frees != allocs.
    test(`allocs ${expectedAllocs} and frees ${expectedAllocs}: ${rule}`, async () => {
      expect(await allocsOf(source)).toEqual({ allocs: expectedAllocs, frees: expectedAllocs });
    });
  }

  // Catches: an object freed twice (frees > allocs) when it is reachable from several holders.
  test("an object reachable from several places is freed once", async () => {
    const heap = await allocsOf("let shared = [1]; let a = [shared]; let b = {k: shared}; let c = [a, b, shared]; shared = nil; a = nil; b = nil; c = nil;");
    expect(heap).toEqual({ allocs: 4, frees: 4 });
  });

  // Catches: the spec's literal counts under evaluation order: the object is created once all elements are evaluated.
  test("an array or record literal whose element fails is never created, but its earlier nested literals were", async () => {
    const cases: [string, number][] = [
      ["[1, 1 / 0];", 0],
      ["{a: 1, b: 1 / 0};", 0],
      ["[[1], 1 / 0];", 1],
      ["{a: [1], b: {c: 2}, d: 1 / 0};", 2],
      ["[[1], [2], [3, 1 / 0]];", 2],
      ["let a = [{x: 1}, [2], [3, [4, missing]]];", 2],
    ];
    for (const [source, expectedAllocs] of cases) {
      const outcome = await exec(source);
      expect(outcome.error).toMatchObject({ kind: "RuntimeError" });
      expect(outcome.heap).toEqual({ allocs: expectedAllocs, frees: expectedAllocs });
    }
  });
});

describe("fetch allocations (7, 10)", () => {
  const io: IoTable = {
    scalar: { value: 5, latencyMs: 0 },
    nothing: { value: null, latencyMs: 0 },
    text: { value: "s", latencyMs: 0 },
    list: { value: [1, 2, 3], latencyMs: 0 },
    empty: { value: [], latencyMs: 0 },
    record: { value: { a: 1 }, latencyMs: 0 },
    emptyRecord: { value: {}, latencyMs: 0 },
    nested: { value: { a: [1, { b: 2 }], c: [], d: { e: { f: [[]] } } }, latencyMs: 0 },
    deepList: { value: [[], [[]], { x: [] }], latencyMs: 0 },
  };
  const fetches: [string, string, number][] = [
    ["an integer", 'fetch("scalar");', 0],
    ["nil", 'fetch("nothing");', 0],
    ["a string", 'fetch("text");', 0],
    ["an array of integers", 'fetch("list");', 1],
    ["an empty array", 'fetch("empty");', 1],
    ["a record of an integer", 'fetch("record");', 1],
    ["an empty record", 'fetch("emptyRecord");', 1],
    ["nested values: every array and record counts", 'fetch("nested");', 8],
    ["arrays and records in an array", 'fetch("deepList");', 1 + 1 + 1 + 1 + 1 + 1],
    ["each fetch makes its own copy", 'fetch("list"); fetch("list"); fetch("record");', 3],
    ["fetch plus a literal and keys", 'let r = fetch("record"); let k = keys(r); let a = [r];', 1 + 1 + 1],
    ["fields read out of a fetched value allocate nothing", 'let n = fetch("nested"); n.a; n.d.e.f; len(n.a);', 8],
  ];
  for (const [rule, source, expectedAllocs] of fetches) {
    // Catches: fetch counting 0 or 1 for the whole value instead of per array/record, or sharing nested objects with io.
    test(`allocs ${expectedAllocs}: ${rule}`, async () => {
      expect(await allocsOf(source, io)).toEqual({ allocs: expectedAllocs, frees: expectedAllocs });
    });
  }

  // Catches: the nested count shortcut (counting only the top level) hidden by the table above.
  test("the copy of a nested value has one object per array and record: 8 for the nested example", async () => {
    const outcome = await expectOk('let n = fetch("nested"); print(n);', io);
    expect(outcome.output).toEqual(["{a: [1, {b: 2}], c: [], d: {e: {f: [[]]}}}"]);
    expect(outcome.heap.allocs).toBe(8);
  });
});

describe("frees equal allocs when run returns", () => {
  // Catches: leaks of objects still reachable when the program ends (globals, closure scopes).
  test("objects still reachable at the end are freed: globals, closures keeping scopes alive, loop arrays", async () => {
    const source = [
      "fn makeCounter() { let cells = [0]; fn next() { cells[0] = cells[0] + 1; return cells[0]; } return next; }",
      "let tick = makeCounter(); tick(); print(tick()); print(tick);",
      "let keep = [[1], {a: [2]}];",
      "for v in [1, 2] { let local = [v]; }",
    ].join("\n");
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["2", "<fn next>"]);
    expect(outcome.heap).toEqual({ allocs: 8, frees: 8 });
  });

  // Catches: a counted heap that cannot free objects only reachable through closure/scope cycles.
  test("scopes that closures keep alive form cycles (scope -> closure -> scope): their objects are still freed", async () => {
    const source = [
      "fn f() { let a = [1]; fn g() { return a; } fn h() { return g; } return 0; }",
      "f(); f(); f();",
      "fn k() { let r = {x: [2]}; fn m() { return r; } return m; }",
      "let one = k(); let two = k(); one = nil;",
    ].join("\n");
    expect(await allocsOf(source)).toEqual({ allocs: 3 + 4, frees: 3 + 4 });
  });

  // Catches: objects held by loop-iteration scopes of closures never freed.
  test("closures created in loops capture per-iteration scopes with their own objects", async () => {
    const source = [
      "let hold = [];",
      "for i in [1, 2, 3] { let data = [i]; fn get() { return data; } push(hold, get); }",
      "let n = 0; while n < 2 { let more = {n: n}; fn peek() { return more; } push(hold, peek); n = n + 1; }",
      "print(len(hold)); print(hold[0]()); print(hold[4]());",
    ].join("\n");
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["5", "[1]", "{n: 1}"]);
    expect(outcome.heap).toEqual({ allocs: 1 + 1 + 3 + 2, frees: 7 });
  });

  // Catches: a returned container freed while it is still held by the caller (and then read).
  test("values returned from calls stay alive; containers nested in returned values too", async () => {
    const source = [
      "fn build(n) { let items = []; let i = 0; while i < n { push(items, {id: i, tags: [i]}); i = i + 1; } return items; }",
      "let list = build(3);",
      "print(list); print(list[2].tags[0]);",
      "list = nil;",
    ].join("\n");
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["[{id: 0, tags: [0]}, {id: 1, tags: [1]}, {id: 2, tags: [2]}]", "2"]);
    expect(outcome.heap).toEqual({ allocs: 7, frees: 7 });
  });

  // Catches: a callee's scope freed too early (while a closure still reaches it) - the read must still work.
  test("a closure keeps its captured scope's objects readable after the creating call returned", async () => {
    const source = [
      "fn make() { let box = {v: [10]}; fn read() { return box.v[0]; } return read; }",
      "let r = make(); let s = make();",
      "print(r() + s());",
    ].join("\n");
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["20"]);
    expect(outcome.heap).toEqual({ allocs: 4, frees: 4 });
  });

  // Catches: a pending call's already evaluated arguments or a for loop's array freed while still needed.
  test("values held only by an evaluation in progress are alive: arguments, operands, the for array", async () => {
    const source = [
      "fn consume(a, b) { return len(a) + len(b); }",
      "fn make(n) { return [n, n]; }",
      "print(consume(make(1), make(2)));",
      "for v in make(3) { print(v + len(make(4))); }",
      "print(len(make(5)) + len(make(6)));",
    ].join("\n");
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["4", "5", "5", "4"]);
    expect(outcome.heap).toEqual({ allocs: 2 + 1 + 2 + 2, frees: 7 });
  });

  // Catches: the for array freed once the variable holding it is reassigned during the loop.
  test("the for array is kept alive until the loop ends even if its variable is dropped", async () => {
    const source = "let a = [1, 2, 3]; for v in a { a = nil; print(v); }";
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["1", "2", "3"]);
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
  });

  // Catches: freed objects counted again at the end (frees > allocs) or objects dropped by reassignment never counted.
  test("objects dropped mid-run and objects alive at the end are each freed exactly once", async () => {
    const source = "let a = [1]; let b = [2]; a = nil; b = [b]; let c = {k: [a, b]}; c = nil;";
    expect(await allocsOf(source)).toEqual({ allocs: 5, frees: 5 });
  });

  // Catches: counting cost growing with the heap (quadratic scans) or a leak per iteration.
  test("a long loop allocating and dropping objects keeps counts exact and runs promptly", async () => {
    const source = "let i = 0; let total = 0; while i < 20000 { let t = [i, {k: i}]; total = total + len(t); i = i + 1; } print(total);";
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["40000"]);
    expect(outcome.heap).toEqual({ allocs: 40000, frees: 40000 });
  }, 30000);

  // Catches: counting cost growing with the live heap.
  test("many objects alive at once are all freed at the end", async () => {
    const source = "let all = []; let i = 0; while i < 5000 { push(all, [i]); i = i + 1; } print(len(all));";
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["5000"]);
    expect(outcome.heap).toEqual({ allocs: 5001, frees: 5001 });
  }, 30000);
});

describe("frees equal allocs after a RuntimeError", () => {
  const cases: [string, string, number][] = [
    ["spec example: index out of range", "let a = [1, 2];\nprint(a⟦[2]);", 1],
    ["objects in the program scope", "let a = [1]; let r = {k: [2]};\n1 ⟦/ 0;", 3],
    ["objects in the scopes of active calls", "fn inner(list) { let local = [list]; return local⟦[5]; }\nfn outer() { let mine = {k: [1]}; return inner([mine]); }\nouter();", 4],
    ["arguments already evaluated for a pending call", "fn two(a, b) { }\ntwo([1], ⟦missing);", 1],
    ["operands of a failing operator", "let r = [1] ⟦+ [2];", 2],
    ["a for array while the loop body fails", "for v in [[1], [2]] {\n  print(v⟦[1]);\n}", 3],
    ["objects held by a closure's scope", "fn make() { let keep = [1]; fn f() { return 1 ⟦/ 0; } return f; }\nlet f = make();\nf();", 1],
    ["after a failed call-depth check", "fn deep(n) { let mine = [n]; return deep⟦(n + 1); }\ndeep(0);", 200],
    ["objects dropped before the failure and objects alive at it", "let a = [1]; a = nil; let b = [2];\nb⟦.f = 1;", 2],
    ["a failing builtin call with live containers", "let r = {a: [1]};\nlen⟦(5);", 2],
    ["a failing fetch of an unknown key", 'let a = [1];\nfetch⟦("nope");', 1],
  ];
  for (const [rule, template, expectedAllocs] of cases) {
    // Catches: objects reachable when the run stops left uncounted as freed (frees < allocs), or alloc counts wrong at the stop.
    test(`allocs ${expectedAllocs} and frees ${expectedAllocs}: ${rule}`, async () => {
      const outcome = await expectRuntimeErrorAt(template);
      expect(outcome.heap).toEqual({ allocs: expectedAllocs, frees: expectedAllocs });
    });
  }

  // Catches: fetch results of a failed program leaking.
  test("fetched values alive at a failure are freed", async () => {
    const io: IoTable = { data: { value: { a: [1, [2]], b: {} }, latencyMs: 5 } };
    const outcome = await expectRuntimeErrorAt('let d = fetch("data");\nprint(d.a[1]⟦[3]);', io);
    expect(outcome.heap).toEqual({ allocs: 4, frees: 4 });
  });
});

describe("heap with concurrent members (9.3, 10)", () => {
  const make = "fn mk(ms) { sleep(ms); return [ms]; }\nfn boom(ms) { sleep(ms); return 1 / 0; }\n";

  // Catches: values returned from concurrent members lost or freed before they are bound.
  test("arrays returned from concurrent members are bound after the run and freed at the end", async () => {
    const outcome = await expectOk(`${make}let a = mk(10);\nlet b = mk(20);\nprint(a); print(b);`);
    expect(outcome.output).toEqual(["[10]", "[20]"]);
    expect(outcome.elapsed).toBe(20);
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });

  // Catches: a returned value discarded by the run (bare call member) never counted as freed.
  test("arrays returned by bare call members are created and freed even though nothing binds them", async () => {
    const outcome = await expectOk(`${make}mk(10);\nmk(20);\nmk(5);`);
    expect(outcome.elapsed).toBe(20);
    expect(outcome.heap).toEqual({ allocs: 3, frees: 3 });
  });

  // Catches: allocations by members whose output was dropped (or that finished after the failing member) not counted.
  test("allocations of members after the failing one still count", async () => {
    const outcome = await exec(`${make}let a = boom(10);\nlet b = mk(20);\nlet c = mk(5);\nprint("unreachable");`);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError" });
    expect(outcome.output).toEqual([]);
    expect(outcome.elapsed).toBe(20);
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });

  // Catches: a member's value created before a failure at the run's end left allocated (frees < allocs).
  test("a value returned by a succeeding member of a failed run is freed", async () => {
    const outcome = await exec(`${make}let a = mk(10);\nlet b = boom(20);`);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError" });
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
  });

  // Catches: argument-evaluation allocations (step 2) not counted, or counted twice on the sequential path.
  test("array literals in the arguments of members are created once, whether the run overlaps or not", async () => {
    const show = "fn show(items) { sleep(10); print(len(items)); }\n";
    const sequential = await expectOk(`${show}show([1, 2]);\nshow([3, [4]]);`);
    expect(sequential.output).toEqual(["2", "2"]);
    expect(sequential.heap).toEqual({ allocs: 3, frees: 3 });
    const mixed = await expectOk(`${SLOW}fn pause(items) { sleep(5); }\nslow("a", 10);\npause([1]);\nslow("b", 10);`);
    expect(mixed.output).toEqual(["a", "b"]);
    expect(mixed.elapsed).toBe(25);
    expect(mixed.heap).toEqual({ allocs: 1, frees: 1 });
  });

  // Catches: step 2 skipped for members after a failing one (so their literals are not counted).
  test("argument evaluation of later members still allocates after an earlier member's arguments failed", async () => {
    const outcome = await exec(`${SLOW}let a = slow("x", 1 / 0);\nlet b = slow("y", [1, 2][5]);`);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError", line: 2, column: 21 });
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
    expect(outcome.sleepCalls).toEqual([]);
  });

  // Catches: the array of an argument evaluated for a member that never runs (sequential fallback after a failure) not counted.
  test("an array evaluated in step 2 is counted even when a failing member earlier in the run means it is never used", async () => {
    const outcome = await exec(`fn show(items) { sleep(10); print(len(items)); }\nshow(1 / 0);\nshow([1, 2]);\nshow([3]);`);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError" });
    expect(outcome.output).toEqual([]);
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });

  // Catches: fetch copies from concurrent members shared or miscounted.
  test("concurrent fetch members each get their own deep copy", async () => {
    const io: IoTable = { shared: { value: { list: [1, 2] }, latencyMs: 30 }, other: { value: [[1]], latencyMs: 10 } };
    const source = 'let a = fetch("shared");\nlet b = fetch("shared");\nlet c = fetch("other");\npush(a.list, 3);\nprint(a.list); print(b.list); print(c);';
    const outcome = await expectOk(source, io);
    expect(outcome.output).toEqual(["[1, 2, 3]", "[1, 2]", "[[1]]"]);
    expect(outcome.elapsed).toBe(30);
    expect(outcome.heap).toEqual({ allocs: 2 + 2 + 2, frees: 6 });
  });

  // Catches: objects created inside members' bodies (not only returned ones) uncounted, or locals freed twice.
  test("objects created and dropped inside concurrent members are counted and freed", async () => {
    const source = "fn work(n) { let scratch = [n]; let more = {k: scratch}; sleep(n); return n; }\nlet a = work(30);\nlet b = work(10);\nlet c = work(20);\nprint(a + b + c);";
    const outcome = await expectOk(source);
    expect(outcome.output).toEqual(["60"]);
    expect(outcome.elapsed).toBe(30);
    expect(outcome.heap).toEqual({ allocs: 6, frees: 6 });
  });

  // Catches: an array passed through the sequential fallback freed after the first member while the second still needs it.
  test("an array shared by sequentially executed members stays alive until the last member is done", async () => {
    const source = "fn grow(items) { sleep(10); push(items, [len(items)]); }\nlet list = [];\ngrow(list);\ngrow(list);\nlist = nil;\ngrow([]);";
    const outcome = await expectOk(source);
    expect(outcome.elapsed).toBe(30);
    expect(outcome.heap).toEqual({ allocs: 1 + 2 + 1 + 1, frees: 5 });
  });
});
