// Spec sections 8 and 9: asynchronous and contained functions, candidates,
// runs, independence, concurrent execution, output grouping and failures.
// Time is the virtual clock of harness.ts: `elapsed` is virtual milliseconds.
// Tier: High (the rules are exact predicates over program text; the output and
// elapsed time of each case follow from them).
import { describe, expect, test } from "bun:test";
import { exec, expectOk, expectRuntimeErrorAt, SLOW, type IoTable } from "./harness.ts";

type Expectation = { output: string[]; elapsed: number };

async function runsAs(source: string, expected: Expectation, io?: IoTable) {
  const outcome = await expectOk(source, io);
  expect({ output: outcome.output, elapsed: outcome.elapsed }).toEqual(expected);
  return outcome;
}

const SLOW_MULTILINE = `fn slow(label, ms) {
  sleep(ms);
  print(label);
  return ms;
}
`;

describe("spec section 12.5 examples", () => {
  // Catches: independent members run one after another (elapsed 700 instead of 300) or printed in finish order.
  test("independent members run concurrently; output is grouped in source order (elapsed 300)", async () => {
    const outcome = await runsAs(`${SLOW_MULTILINE}let a = slow("a", 300);\nlet b = slow("b", 100);\nprint(a + b);`, {
      output: ["a", "b", "400"],
      elapsed: 300,
    });
    expect(outcome.sleepCalls).toEqual([
      { startedAt: 0, ms: 300 },
      { startedAt: 0, ms: 100 },
    ]);
  });

  // Catches: dependency through a name not detected (elapsed 300 instead of 600, or reading an uninitialized a).
  test("dependent members run one at a time (elapsed 600)", async () => {
    const outcome = await runsAs(`${SLOW_MULTILINE}let a = slow("a", 300);\nlet b = slow("b", a);\nprint(a + b);`, {
      output: ["a", "b", "600"],
      elapsed: 600,
    });
    expect(outcome.sleepCalls).toEqual([
      { startedAt: 0, ms: 300 },
      { startedAt: 300, ms: 300 },
    ]);
  });

  // Catches: wait ignored, or a run extended across the wait-prefixed statement.
  test("wait runs a statement alone (elapsed 300)", async () => {
    await runsAs(`${SLOW_MULTILINE}let a = slow("a", 100);\nwait let b = slow("b", 100);\nlet c = slow("c", 100);\nprint(a + b + c);`, {
      output: ["a", "b", "c", "300"],
      elapsed: 300,
    });
  });

  // Catches: a failing member stopping the others, later output kept, or the error taken from the wrong member.
  test("a failing member: all start together, earliest failing member wins, later output dropped (elapsed 100)", async () => {
    const source = `fn slow(label, ms) {
  sleep(ms);
  print(label);
  return ms;
}
fn boom(ms) { sleep(ms); print("boom"); return 1 / 0; }
let a = slow("a", 100);
let b = boom(50);
let c = slow("c", 10);
print("unreachable");`;
    const outcome = await exec(source);
    expect(outcome.output).toEqual(["a", "boom"]);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError", line: 6, column: 50 });
    expect(outcome.elapsed).toBe(100);
    expect(outcome.heap.frees).toBe(outcome.heap.allocs);
  });

  // Catches: array arguments allowed to run concurrently (elapsed 10 instead of 20).
  test("array arguments run one at a time (elapsed 20)", async () => {
    const outcome = await runsAs("fn show(items) { sleep(10); print(len(items)); }\nlet list = [1, 2];\nshow(list);\nshow(list);", {
      output: ["2", "2"],
      elapsed: 20,
    });
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
  });

  // Catches: a function that mutates a non-local treated as contained.
  test("a function that mutates a non-local is not contained (elapsed 20)", async () => {
    await runsAs("let total = [0];\nfn add(n) { sleep(10); total[0] = total[0] + n; }\nadd(1);\nadd(2);\nprint(total[0]);", {
      output: ["3"],
      elapsed: 20,
    });
  });

  // Catches: fetch not overlapping, or a wrong latency taken (elapsed 70, not 110).
  test("fetch runs concurrently with the clock (elapsed 70)", async () => {
    const io: IoTable = {
      user: { value: { name: "ana" }, latencyMs: 40 },
      posts: { value: [1, 2, 3], latencyMs: 70 },
    };
    const outcome = await runsAs('let user = fetch("user");\nlet posts = fetch("posts");\nprint(user.name);\nprint(len(posts));', { output: ["ana", "3"], elapsed: 70 }, io);
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });
});

describe("candidates and runs (9.1)", () => {
  // Catches: sleep/fetch not recognized as candidates, or members not starting at the same clock instant.
  test("two sleeps in one run overlap: virtual time is 100, not 200, and both start at 0", async () => {
    const outcome = await runsAs("sleep(100);\nsleep(100);", { output: [], elapsed: 100 });
    expect(outcome.sleepCalls).toEqual([
      { startedAt: 0, ms: 100 },
      { startedAt: 0, ms: 100 },
    ]);
  });

  // Catches: only the first two members overlapping; ties or order of wake-ups mishandled.
  test("a run of several members takes the longest member's time; the clock sees the sleeps in source order", async () => {
    const outcome = await runsAs("sleep(100); sleep(200); sleep(50); sleep(0); sleep(200);", { output: [], elapsed: 200 });
    expect(outcome.sleepCalls.map((call) => call.ms)).toEqual([100, 200, 50, 0, 200]);
    expect(outcome.sleepCalls.every((call) => call.startedAt === 0)).toBe(true);
  });

  // Catches: the next statement starting before the run has finished.
  test("the statement after a run starts when every member has finished", async () => {
    const outcome = await runsAs('sleep(100); sleep(300); print("after"); sleep(50);', { output: ["after"], elapsed: 350 });
    expect(outcome.sleepCalls.map((call) => call.startedAt)).toEqual([0, 0, 300]);
  });

  // Catches: let and expression-statement members not mixing in one run.
  test("let members and bare call members form one run", async () => {
    await runsAs(`${SLOW}let a = slow("a", 100);\nslow("b", 100);\nsleep(100);\nlet c = slow("c", 50);\nprint(a + c);`, {
      output: ["a", "b", "c", "150"],
      elapsed: 100,
    });
  });

  // Catches: wait prefix placement; the run ends at the wait statement and a new run starts after it.
  test("wait splits runs: members before it, the wait statement alone, members after it", async () => {
    const outcome = await runsAs("sleep(100); sleep(40); wait sleep(30); sleep(20); sleep(70);", { output: [], elapsed: 100 + 30 + 70 });
    expect(outcome.sleepCalls.map((call) => call.startedAt)).toEqual([0, 0, 100, 130, 130]);
  });

  // Catches: wait only accepted on let / only honoured on let.
  test("wait applies to a simple statement as well as to a let", async () => {
    await runsAs("wait sleep(100); wait sleep(100); sleep(100);", { output: [], elapsed: 300 });
    await runsAs(`${SLOW}wait slow("a", 100); wait let b = slow("b", 100); print(b);`, { output: ["a", "b", "100"], elapsed: 200 });
  });

  // Catches: a wait at the start or end of a run not counted as a boundary.
  test("a wait-prefixed statement is alone even between two other runs of two", async () => {
    await runsAs("sleep(10); sleep(10); wait sleep(10); sleep(10); sleep(10); wait sleep(10); sleep(10); sleep(10);", {
      output: [],
      elapsed: 10 + 10 + 10 + 10 + 10,
    });
  });

  const breakers: [string, string, Expectation][] = [
    ["a print statement", 'sleep(100); print("mid"); sleep(100);', { output: ["mid"], elapsed: 200 }],
    ["a plain let", "sleep(100); let x = 1; sleep(100);", { output: [], elapsed: 200 }],
    ["an assignment", "let x = 0; sleep(100); x = 1; sleep(100);", { output: [], elapsed: 200 }],
    ["an if statement", "sleep(100); if true { } sleep(100);", { output: [], elapsed: 200 }],
    ["a fn declaration", "sleep(100); fn unused() { } sleep(100);", { output: [], elapsed: 200 }],
    ["a call in an argument", 'sleep(100); sleep(len("ab")); sleep(100);', { output: [], elapsed: 202 }],
    ["a call nested deep in an argument", 'sleep(100); sleep([len("abc")][0]); sleep(100);', { output: [], elapsed: 203 }],
    ["a call in an argument inside a record literal", 'sleep(100); sleep({k: len("a")}.k); sleep(100);', { output: [], elapsed: 201 }],
    ["a non-asynchronous user function", "fn quick(x) { print(x); }\nsleep(100); quick(1); sleep(100);", { output: ["1"], elapsed: 200 }],
    ["a callee that is a variable", `${SLOW}let g = slow;\nlet a = g("a", 100);\nlet b = g("b", 100);`, { output: ["a", "b"], elapsed: 200 }],
    ["a parenthesized callee", `${SLOW}(slow)("a", 100);\n(slow)("b", 100);`, { output: ["a", "b"], elapsed: 200 }],
    ["a call result used in an expression", `${SLOW}let a = slow("a", 100) + 0;\nlet b = slow("b", 100) + 0;`, { output: ["a", "b"], elapsed: 200 }],
    ["a call result that is itself called", `${SLOW}fn id(x) { return x; }\nlet a = id(slow)("a", 100);\nlet b = id(slow)("b", 100);`, { output: ["a", "b"], elapsed: 200 }],
    ["a return statement's call", `${SLOW}fn two() { slow("a", 100); return slow("b", 100); }\ntwo();`, { output: ["a", "b"], elapsed: 200 }],
    ["a field callee", `${SLOW}let r = {f: slow};\nr.f("a", 100);\nr.f("b", 100);`, { output: ["a", "b"], elapsed: 200 }],
    ["an index callee", `${SLOW}let fs = [slow];\nfs[0]("a", 100);\nfs[0]("b", 100);`, { output: ["a", "b"], elapsed: 200 }],
    ["an assignment of a call result", `${SLOW}let a = 0; let b = 0;\na = slow("a", 100);\nb = slow("b", 100);`, { output: ["a", "b"], elapsed: 200 }],
    ["a call whose first member is a run of one", 'sleep(100); sleep(len("x"));', { output: [], elapsed: 101 }],
  ];
  for (const [rule, source, expected] of breakers) {
    // Catches: a statement that is not a candidate taking part in a run (or two candidates separated by it overlapping).
    test(`not a candidate or ends the run: ${rule}`, async () => {
      await runsAs(source, expected);
    });
  }

  // Catches: runs recognized only at program level.
  test("runs are found in every statement list: function bodies, if/else, while and for blocks", async () => {
    await runsAs("fn two() { sleep(100); sleep(100); }\ntwo();", { output: [], elapsed: 100 });
    await runsAs("if true { sleep(100); sleep(100); }", { output: [], elapsed: 100 });
    await runsAs("if false { } else { sleep(100); sleep(100); }", { output: [], elapsed: 100 });
    await runsAs("for i in [1, 2] { sleep(100); sleep(100); }", { output: [], elapsed: 200 });
    await runsAs("let n = 0; while n < 3 { sleep(10); sleep(10); n = n + 1; }", { output: [], elapsed: 30 });
  });

  // Catches: a run of independent members joined across two statement lists.
  test("a run never spans statement lists: the last statement of a block and the next one after it are separate", async () => {
    await runsAs("if true { sleep(100); } sleep(100);", { output: [], elapsed: 200 });
    await runsAs("sleep(100); for i in [1] { sleep(100); }", { output: [], elapsed: 200 });
  });

  // Catches: candidates restricted to builtins; user functions not recognized.
  test("a user function that is asynchronous and contained is a candidate", async () => {
    await runsAs(`${SLOW}slow("a", 100);\nslow("b", 100);`, { output: ["a", "b"], elapsed: 100 });
  });

  // Catches: asynchrony not propagated through calls by name (a function that only calls an async function).
  test("asynchrony is transitive: f calls g calls h which sleeps", async () => {
    const source = "fn h() { sleep(100); }\nfn g() { h(); }\nfn f() { g(); }\nf();\nf();";
    await runsAs(source, { output: [], elapsed: 100 });
  });

  // Catches: mutual recursion mishandled in the least-fixed-point computation.
  test("asynchrony through mutual recursion: both functions are asynchronous when one of them sleeps", async () => {
    const source = [
      "fn even(n) { if n == 0 { sleep(100); return true; } return odd(n - 1); }",
      "fn odd(n) { if n == 0 { return false; } return even(n - 1); }",
      "let a = even(4);",
      "let b = odd(3);",
      "print(a); print(b);",
    ].join("\n");
    await runsAs(source, { output: ["true", "true"], elapsed: 100 });
  });

  // Catches: fetch inside a user function not making it asynchronous.
  test("a function that calls fetch is asynchronous", async () => {
    const io: IoTable = { k: { value: 1, latencyMs: 50 } };
    await runsAs('fn load() { return fetch("k"); }\nlet a = load();\nlet b = load();\nprint(a + b);', { output: ["2"], elapsed: 50 }, io);
  });

  // Catches: a nested fn's sleep making the outer function asynchronous, or a call to the nested fn not counting.
  test("calls inside a nested fn do not make the outer function asynchronous; a call by name to it does", async () => {
    // outer only declares inner and returns it: it never sleeps, so it is not a candidate and the runs below stay sequential.
    const declaresOnly = "fn outer() { fn inner() { sleep(100); } return inner; }\nlet a = outer();\nlet b = outer();\na();\nb();";
    await runsAs(declaresOnly, { output: [], elapsed: 200 });
    const callsInner = "fn outer() { fn inner() { sleep(100); } inner(); }\nouter();\nouter();";
    await runsAs(callsInner, { output: [], elapsed: 100 });
  });
});

describe("contained functions (8)", () => {
  // Each program calls the function twice as a run of two. Contained => elapsed 10, not contained => elapsed 20.
  const twice = (declarations: string, call = "w") => `${declarations}\n${call}();\n${call}();`;

  const sequential: [string, string][] = [
    ["rule 1: an opaque call (callee is a parameter)", "fn noop() { }\nfn w(f) { sleep(10); f(); }\nw(noop);\nw(noop);"],
    ["rule 1: an opaque call (callee is a variable)", twice("fn noop() { }\nfn w() { let f = noop; sleep(10); f(); }")],
    ["rule 1: an opaque call (callee is an index)", twice("fn noop() { }\nfn w() { let fs = [noop]; sleep(10); fs[0](); }")],
    ["rule 1: an opaque call (callee is a field)", twice("fn noop() { }\nfn w() { let r = {f: noop}; sleep(10); r.f(); }")],
    ["rule 1: an opaque call (callee is a call result)", twice("fn noop() { }\nfn id(x) { return x; }\nfn w() { sleep(10); id(noop)(); }")],
    ["rule 1: an opaque call (callee is parenthesized)", twice("fn w() { sleep(10); (print)(1); }")],
    ["rule 1: an opaque call (unresolved callee name is not run: dead branch)", twice("fn w() { sleep(10); if false { missing(); } }")],
    ["rule 1: an opaque call in a function it calls", twice("fn apply(f) { f(); }\nfn noop() { }\nfn w() { sleep(10); apply(noop); }")],
    ["rule 1: an opaque call three calls deep", twice("fn c(f) { f(); }\nfn b(f) { c(f); }\nfn a() { sleep(10); b(print2); }\nfn print2() { }\nfn w() { a(); }")],
    ["rule 2: assigns a non-local variable", "let total = 0;\nfn w() { sleep(10); total = total + 1; }\nw();\nw();"],
    ["rule 2: assigns a non-local variable of an enclosing function", twice("fn w() { let n = 0; fn bump() { n = n + 1; } sleep(10); bump(); }")],
    ["rule 2: assigns a non-local variable in a function it calls", "let total = 0;\nfn bump() { total = 1; }\nfn w() { sleep(10); bump(); }\nw();\nw();"],
    ["rule 2: assigns an unresolved name", twice("fn w() { sleep(10); if false { missing = 1; } }")],
    ["rule 3: index assignment on a non-local array", "let cells = [0];\nfn w() { sleep(10); cells[0] = 1; }\nw();\nw();"],
    ["rule 3: field assignment on a non-local record", "let state = {n: 0};\nfn w() { sleep(10); state.n = 1; }\nw();\nw();"],
    ["rule 3: push onto a non-local array", "let log = [];\nfn w() { sleep(10); push(log, 1); }\nw();\nw();"],
    ["rule 3: push in a function it calls", "let log = [];\nfn record() { push(log, 1); }\nfn w() { sleep(10); record(); }\nw();\nw();"],
    ["rule 3: a deep field path on a non-local", "let state = {inner: {n: 0}};\nfn w() { sleep(10); state.inner.n = 1; }\nw();\nw();"],
    ["rule 3: a mutation with no root (call result base)", twice("fn id(x) { return x; }\nfn w() { let r = {y: 0}; sleep(10); id(r).y = 1; }")],
    ["rule 3: a mutation with no root (parenthesized base)", twice("fn w() { let r = {y: 0}; sleep(10); (r).y = 1; }")],
    ["rule 3: a push with no root (literal)", twice("fn w() { sleep(10); push([1], 2); }")],
    ["rule 3: a push whose first argument is a call result", twice("fn id(x) { return x; }\nfn w() { let a = [1]; sleep(10); push(id(a), 2); }")],
    ["rule 4: a local mutation and a non-local read in the same function", "let base = 5;\nfn w() { let tmp = []; push(tmp, 1); sleep(10); return base; }\nw();\nw();"],
    ["rule 4: a local mutation here, a non-local read in a function it calls", "let base = 5;\nfn read() { return base; }\nfn w() { let tmp = []; push(tmp, 1); sleep(10); read(); }\nw();\nw();"],
    ["rule 4: a non-local read here, a local mutation in a function it calls", "let base = 5;\nfn fill() { let tmp = []; push(tmp, 1); }\nfn w() { sleep(10); fill(); return base; }\nw();\nw();"],
    ["rule 4: an unresolved name counts as a non-local occurrence", twice("fn w() { let tmp = []; push(tmp, 1); sleep(10); if false { print(missing); } }")],
    ["reach: the unsafe function is reached through an asynchronous one", "let total = [0];\nfn unsafe() { sleep(10); total[0] = 1; }\nfn w() { unsafe(); }\nw();\nw();"],
  ];
  for (const [rule, source] of sequential) {
    // Catches: a function that violates one containment rule treated as contained (members overlapped: elapsed 10).
    test(`not contained, so members run one at a time (elapsed 20): ${rule}`, async () => {
      const outcome = await exec(source);
      expect(outcome.error).toBeNull();
      expect(outcome.elapsed).toBe(20);
    });
  }

  const concurrent: [string, string][] = [
    ["a pure async function", twice("fn w() { sleep(10); }")],
    ["a local variable assigned", twice("fn w() { let t = 0; t = 1; sleep(10); return t; }")],
    ["a parameter assigned", "fn w(x) { x = x + 1; sleep(10); return x; }\nlet a = w(1);\nlet b = w(2);"],
    ["a loop variable assigned", twice("fn w() { for i in [1] { i = 2; } sleep(10); }")],
    ["a variable assigned in a nested block of the function", twice("fn w() { let t = 0; if true { t = 1; } sleep(10); }")],
    ["a local array mutated by index, field and push", twice("fn w() { let a = [0]; let r = {k: 0}; a[0] = 1; r.k = 2; push(a, 3); r.extra = a[1]; sleep(10); }")],
    ["a local deep path mutated", twice("fn w() { let r = {inner: {n: 0}}; r.inner.n = 1; let a = [[0]]; a[0][0] = 2; sleep(10); }")],
    ["a parameter's contents mutated (the argument is not an array)", "fn w(x) { let local = [x]; local[0] = 2; sleep(10); }\nw(1);\nw(2);"],
    ["a non-local read without any mutation", "let base = 5;\nfn w() { sleep(10); return base + 1; }\nlet a = w();\nlet b = w();\nprint(a + b);"],
    ["non-local reads in the function and in one it calls, no mutation", "let base = 5;\nfn read() { return base; }\nfn w() { sleep(10); return read() + base; }\nlet a = w();\nlet b = w();"],
    ["a mutation together with fn and builtin occurrences only", "fn helper() { return 1; }\nfn w() { let tmp = []; push(tmp, helper()); sleep(10); return len(tmp) + helper(); }\nlet a = w();\nlet b = w();"],
    ["a mutation in a function it calls that only touches its own locals", "fn fill() { let tmp = []; push(tmp, 1); return tmp; }\nfn w() { fill(); sleep(10); }\nw();\nw();"],
    ["a nested fn's opaque call and non-local assignment are not the outer function's", twice("fn w() { fn inner(f) { f(); } let n = 0; fn bump() { n = 1; } sleep(10); }")],
    ["a call by name to a fn declared in the function", twice("fn w() { fn step() { sleep(10); } step(); }")],
    ["recursion that never touches non-local state", "fn w(n) { if n > 0 { w(n - 1); } else { sleep(10); } }\nw(3);\nw(3);"],
  ];
  for (const [rule, source] of concurrent) {
    // Catches: a containment rule applied too strictly (members forced sequential: elapsed 20).
    test(`contained, so members overlap (elapsed 10): ${rule}`, async () => {
      const outcome = await exec(source);
      expect(outcome.error).toBeNull();
      expect(outcome.elapsed).toBe(10);
    });
  }
});

// Spec 8 and 9.2 read the whole function text, not only plain statements: the expression of an `if`, of every `else if`
// of a chain, of a `while` and of a `for` counts like any other. Each case puts one hazard in one such position.
describe("expressions outside a plain statement (8, 9.2)", () => {
  // `condition` and `iterable` wrap an expression E that evaluates to nil/5/100 so the program stays well-typed and E is evaluated.
  const positions: [string, (expression: string) => string][] = [
    ["an if condition", (expression) => `if ${expression} == 1 { }`],
    ["an else-if condition", (expression) => `if false { } else if ${expression} == 1 { }`],
    ["the third condition of an else-if chain", (expression) => `if false { } else if false { } else if ${expression} == 1 { }`],
    ["an else-if condition inside a loop body", (expression) => `for once in [1] { if false { } else if ${expression} == 1 { } }`],
    ["a while condition", (expression) => `while ${expression} == 1 { }`],
    ["a for iterable", (expression) => `for item in [${expression}] { }`],
  ];
  const twiceWithBody = (globals: string, body: string) => `${globals}\nfn w() { ${body} }\nw();\nw();`;

  // Each hazard is one containment rule: [name, globals, prelude of w, expression E placed in the position].
  const hazards: [string, string, string, string][] = [
    ["rule 1: an opaque call", "fn noop() { }", "let f = noop;", "f()"],
    ["rule 3: a push onto a non-local array", "let log = [];", "", "push(log, 1)"],
    ["rule 4: a non-local read next to a local mutation", "let base = 5;", "let tmp = []; push(tmp, 1);", "base"],
    ["reach: a call by name to a function that pushes onto a non-local array", "let log = [];\nfn touch() { push(log, 1); }", "", "touch()"],
  ];
  for (const [positionName, place] of positions) {
    for (const [hazardName, globals, prelude, expression] of hazards) {
      // Catches: the analysis skips this expression position (else-if condition: shipped in the reference), so a non-contained function runs concurrently (elapsed 10).
      test(`not contained, so members run one at a time (elapsed 20): ${hazardName} in ${positionName}`, async () => {
        const outcome = await exec(twiceWithBody(globals, `${prelude} sleep(10); ${place(expression)}`));
        expect(outcome.error).toBeNull();
        expect(outcome.elapsed).toBe(20);
      });
    }
  }

  const asynchronousSources: [string, string, string][] = [
    ["a call to sleep", "", "sleep(10)"],
    ["a call by name to an asynchronous function", "fn step() { sleep(10); }", "step()"],
  ];
  for (const [positionName, place] of positions) {
    for (const [sourceName, globals, expression] of asynchronousSources) {
      // Catches: a call in this position not seen, so the function is not asynchronous, its calls are not candidates and run one at a time (elapsed 20).
      test(`asynchronous and contained, so members overlap (elapsed 10): ${sourceName} in ${positionName}`, async () => {
        const outcome = await exec(twiceWithBody(globals, place(expression)));
        expect(outcome.error).toBeNull();
        expect(outcome.elapsed).toBe(10);
      });
    }
  }

  for (const [positionName, place] of positions) {
    // Catches: a name read in this position not counted as a use of the callee, so it runs concurrently with the member that defines it (error or elapsed 100).
    test(`a callee reading another member's variable in ${positionName} waits for it (elapsed 200)`, async () => {
      const source = [SLOW, `fn readA() { sleep(100); ${place("a")} }`, 'let a = slow("a", 100);', "let b = readA();"].join("\n");
      const outcome = await exec(source);
      expect(outcome.error).toBeNull();
      expect({ output: outcome.output, elapsed: outcome.elapsed }).toEqual({ output: ["a"], elapsed: 200 });
    });
  }
});

describe("independence (9.2)", () => {
  // Catches: dependency via a name the later member passes as an argument (spec example, plus arithmetic on it).
  test("a member whose argument mentions a name defined by another member waits for it", async () => {
    await runsAs(`${SLOW}let a = slow("a", 100);\nlet b = slow("b", a * 2);\nprint(a + b);`, { output: ["a", "b", "300"], elapsed: 300 });
  });

  // Catches: only the first member's definitions compared with the second's uses.
  test("one dependent pair makes the whole run sequential, even for members independent of everything", async () => {
    const outcome = await runsAs(`${SLOW}let a = slow("a", 100);\nlet b = slow("b", a);\nlet c = slow("c", 100);`, {
      output: ["a", "b", "c"],
      elapsed: 300,
    });
    expect(outcome.sleepCalls.map((call) => call.startedAt)).toEqual([0, 100, 200]);
  });

  // Catches: a dependency between non-adjacent members missed.
  test("a dependency between the first and the third member is found", async () => {
    await runsAs(`${SLOW}let a = slow("a", 100);\nlet b = slow("b", 100);\nlet c = slow("c", a);`, { output: ["a", "b", "c"], elapsed: 300 });
  });

  // Catches: dependency through a variable the callee reads in the function body (uses of reach(F)).
  test("a callee that reads a variable defined by an earlier member waits for it", async () => {
    const source = [
      SLOW,
      'fn readA() { sleep(100); print("r"); return a; }',
      'let a = slow("a", 100);',
      "let b = readA();",
      "print(b);",
    ].join("\n");
    await runsAs(source, { output: ["a", "r", "100"], elapsed: 200 });
  });

  // Catches: only the callee's own body inspected (not the functions it calls).
  test("the dependency may sit in a function the callee calls (transitively)", async () => {
    const source = [
      SLOW,
      "fn lookup() { return a; }",
      "fn middle() { return lookup(); }",
      'fn readA() { sleep(100); return middle(); }',
      'let a = slow("a", 100);',
      "let b = readA();",
      "print(b);",
    ].join("\n");
    await runsAs(source, { output: ["a", "100"], elapsed: 200 });
  });

  // Catches: all identifier names of the callee's body counted as uses instead of occurrences that resolve outside it.
  test("a parameter or local of the callee that has the same name as another member's let is not a use", async () => {
    const source = "fn f(n) { sleep(100); return n; }\nlet n = f(1);\nlet m = f(2);\nprint(n + m);";
    await runsAs(source, { output: ["3"], elapsed: 100 });
    const local = "fn f() { let n = 0; sleep(100); return n; }\nlet n = f();\nlet m = f();";
    await runsAs(local, { output: [], elapsed: 100 });
  });

  // Catches: a shared use treated as a dependency (only defines matter).
  test("members that merely share a variable, the callee or an argument name are independent", async () => {
    const source = `${SLOW}let delay = 100;\nlet a = slow("a", delay);\nlet b = slow("b", delay);\nlet c = slow("c", delay);\nprint(a + b + c);`;
    await runsAs(source, { output: ["a", "b", "c", "300"], elapsed: 100 });
  });

  // Catches: indexing or field access on a shared array/record forcing a dependency or an array-argument fallback.
  test("integers read out of a shared array or record are plain arguments: members overlap", async () => {
    const source = `${SLOW}let delays = [100, 200];\nlet cfg = {long: 300};\nlet a = slow("a", delays[0]);\nlet b = slow("b", delays[1]);\nlet c = slow("c", cfg.long);`;
    await runsAs(source, { output: ["a", "b", "c"], elapsed: 300 });
  });

  // Catches: builtin names counted as uses/defines.
  test("builtin names used inside callees never create a dependency", async () => {
    const source = "fn w(tag) { sleep(10); print(len(tag)); }\nw(\"ab\");\nw(\"abc\");";
    await runsAs(source, { output: ["2", "3"], elapsed: 10 });
  });

  // Catches: a run containing wait-split halves analysed together.
  test("independence is decided per run: a dependency across a wait does not matter", async () => {
    await runsAs(`${SLOW}let a = slow("a", 100);\nlet x = slow("x", 100);\nwait let b = slow("b", a);\nlet c = slow("c", 100);\nlet d = slow("d", 100);`, {
      output: ["a", "x", "b", "c", "d"],
      elapsed: 100 + 100 + 100,
    });
  });
});

describe("array and record arguments (9.3 step 3)", () => {
  const show = "fn show(items) { sleep(10); print(len(items)); }\n";

  // Catches: array arguments allowed to overlap; only variables (not literals) detected.
  test.each([
    ["a variable holding an array", `${show}let list = [1, 2];\nshow(list);\nshow(list);`, ["2", "2"], 20],
    ["array literals", `${show}show([1]);\nshow([1, 2, 3]);`, ["1", "3"], 20],
    ["a record literal", `${show}show({a: 1});\nshow({b: 1, c: 2});`, ["1", "2"], 20],
    ["a record variable", `${show}let rec = {k: 1};\nshow(rec);\nshow(rec);`, ["1", "1"], 20],
    ["an array only in one member", `${show}let list = [1];\nsleep(100);\nshow(list);`, ["1"], 110],
    ["an array element that is an array", `${show}let nest = [[1, 2], [3]];\nshow(nest[0]);\nshow(nest[1]);`, ["2", "1"], 20],
    ["an array held by a record field", `${show}let holder = {items: [1, 2, 3]};\nshow(holder.items);\nshow(holder.items);`, ["3", "3"], 20],
    ["an array-valued argument among several arguments", "fn mix(n, items) { sleep(n); print(len(items)); }\nmix(10, [1]);\nmix(10, [2, 3]);", ["1", "2"], 20],
  ])("a member with an array/record argument value makes the run sequential: %s", async (_label, source, output, elapsed) => {
    await runsAs(source, { output, elapsed });
  });

  // Catches: array detection by static type of the expression instead of the computed value.
  test("what counts is the value computed in step 2: an expression that yields an array, not only an array literal", async () => {
    const source = `${show}let nest = [[1, 2], [3]];\nlet pick = 1;\nshow(nest[pick - 1]);\nshow(nest[pick]);`;
    await runsAs(source, { output: ["2", "1"], elapsed: 20 });
  });

  // Catches: scalar values (strings, booleans, nil) misclassified as references.
  test("strings, booleans, nil and integers are not arrays or records: the run overlaps", async () => {
    const source = "fn w(v) { sleep(10); print(v); }\nw(\"s\");\nw(true);\nw(nil);\nw(5);";
    await runsAs(source, { output: ["s", "true", "nil", "5"], elapsed: 10 });
  });

  // Catches: argument values evaluated again when the members run sequentially (double allocation / double effect).
  test("the already computed argument values are used: array literals are created once", async () => {
    const outcome = await runsAs(`${show}show([1, 2]);\nshow([3]);`, { output: ["2", "1"], elapsed: 20 });
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });

  // Catches: sequential fallback reordering the members' output, or sharing state between them.
  test("sequentially executed members still see each other's effects in order", async () => {
    const source = "fn grow(items) { sleep(10); push(items, len(items)); }\nlet list = [];\ngrow(list);\ngrow(list);\ngrow(list);\nprint(list);";
    await runsAs(source, { output: ["[0, 1, 2]"], elapsed: 30 });
  });
});

describe("output of concurrent members (9.4)", () => {
  // Catches: output interleaved by time instead of grouped per member.
  test("each member's prints are grouped, members in source order, even when the clock interleaves them", async () => {
    const source = [
      'fn two(label, ms) { print(label + "1"); sleep(ms); print(label + "2"); }',
      'two("a", 200);',
      'two("b", 100);',
      'two("c", 0);',
    ].join("\n");
    const outcome = await runsAs(source, { output: ["a1", "a2", "b1", "b2", "c1", "c2"], elapsed: 200 });
    expect(outcome.sleepCalls.map((call) => call.ms)).toEqual([200, 100, 0]);
  });

  // Catches: output of nested calls inside a member attributed to the wrong member.
  test("output of calls nested inside a member belongs to that member", async () => {
    const source = [
      'fn inner(x) { print("inner " + x); }',
      'fn outer(x, ms) { sleep(ms); inner(x); print("outer " + x); }',
      'outer("a", 100);',
      'outer("b", 10);',
    ].join("\n");
    await runsAs(source, { output: ["inner a", "outer a", "inner b", "outer b"], elapsed: 100 });
  });

  // Catches: output before/after the run reordered with the members' output.
  test("output before the run is unchanged and output after it follows the members", async () => {
    const source = `${SLOW}print("before");\nslow("a", 20);\nslow("b", 10);\nprint("after");`;
    await runsAs(source, { output: ["before", "a", "b", "after"], elapsed: 20 });
  });

  // Catches: a member's prints dropped when the member returns a value used later.
  test("prints of let members and the values they return both survive", async () => {
    await runsAs(`${SLOW}let a = slow("a", 30);\nlet b = slow("b", 20);\nlet c = slow("c", 10);\nprint(c);\nprint(b);\nprint(a);`, {
      output: ["a", "b", "c", "10", "20", "30"],
      elapsed: 30,
    });
  });

  // Catches: nested runs failing to nest (inner concurrency lost or inner output misplaced).
  test("concurrency nests: members whose bodies contain runs; time is the longest path", async () => {
    const source = [
      SLOW,
      "fn pair() { let x = slow(\"x\", 100); let y = slow(\"y\", 200); return x + y; }",
      "let p = pair();",
      "let q = pair();",
      "print(p); print(q);",
    ].join("\n");
    const outcome = await runsAs(source, { output: ["x", "y", "x", "y", "300", "300"], elapsed: 200 });
    expect(outcome.sleepCalls.map((call) => call.startedAt)).toEqual([0, 0, 0, 0]);
  });

  // Catches: a nested dependency leaking out (inner sequential, outer still concurrent).
  test("an inner dependent run is sequential inside its member while the outer run still overlaps", async () => {
    const source = [
      SLOW,
      'fn chain() { let a = slow("a", 100); let b = slow("b", a); return b; }',
      "let p = chain();",
      "let q = chain();",
    ].join("\n");
    await runsAs(source, { output: ["a", "b", "a", "b"], elapsed: 200 });
  });

  // Catches: a nested member's failure losing the outer ordering rule.
  test("a failure inside a nested run propagates as the member's failure", async () => {
    const source = [
      SLOW,
      'fn bad() { let x = slow("x", 10); let y = 1 / 0; return x; }',
      'fn nested() { let a = slow("a", 50); let b = slow("b", 20); wait let c = bad(); return a; }',
      'let first = nested();',
      'let second = slow("second", 5);',
      'print("unreachable");',
    ].join("\n");
    const outcome = await exec(source);
    expect(outcome.error?.kind).toBe("RuntimeError");
    expect(outcome.output).toEqual(["a", "b", "x"]);
    expect(outcome.elapsed).toBe(50 + 10);
  });
});

describe("failures in a run (9.3 steps 2-5, 9.4)", () => {
  const show = "fn show(items) { sleep(10); print(len(items)); }\n";
  const failing = `${SLOW}fn ba() { sleep(200); print("A"); return 1 / 0; }\nfn bb() { sleep(50); print("B"); return 2 % 0; }\n`;

  // Catches: the earliest failure in time (not in source order) reported.
  test("the earliest failing member in source order supplies the error, even if it fails later in time", async () => {
    const outcome = await expectRuntimeErrorAt(
      `${SLOW}fn ba() { sleep(200); print("A"); return 1 ⟦/ 0; }\nfn bb() { sleep(50); print("B"); return 2 % 0; }\nlet a = ba();\nlet b = bb();\nprint("unreachable");`,
    );
    expect(outcome.output).toEqual(["A"]);
    expect(outcome.elapsed).toBe(200);
  });

  // Catches: output of members before the failing one lost, or the failing member's own earlier output lost.
  test("output kept: members up to and including the earliest failing one, with its prints before the failure", async () => {
    const outcome = await exec(`${failing}let a = slow("a", 10);\nlet b = bb();\nlet c = slow("c", 5);\nlet d = ba();`);
    expect(outcome.output).toEqual(["a", "B"]);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError" });
  });

  // Catches: the run aborting as soon as the first member fails (the others must finish).
  test("a failed member does not stop the others: the run ends when all have finished", async () => {
    const outcome = await exec(`${SLOW}fn boom() { sleep(10); print("boom"); return 1 / 0; }\nlet a = boom();\nlet b = slow("b", 500);`);
    expect(outcome.output).toEqual(["boom"]);
    expect(outcome.elapsed).toBe(500);
    expect(outcome.error).toMatchObject({ kind: "RuntimeError" });
  });

  // Catches: statements after a failed run executing.
  test("nothing after a failed run executes", async () => {
    const outcome = await exec(`${SLOW}fn boom() { sleep(1); return 1 / 0; }\nlet a = boom();\nlet b = slow("b", 1);\nprint("after");\nsleep(1000);`);
    expect(outcome.output).toEqual([]);
    expect(outcome.elapsed).toBe(1);
    expect(outcome.sleepCalls).toEqual([
      { startedAt: 0, ms: 1 },
      { startedAt: 0, ms: 1 },
    ]);
  });

  // Catches: an argument error aborting the whole step 2 / stopping other members from running.
  test("an argument error is that member's failure: the member is not called, the others still run", async () => {
    const outcome = await expectRuntimeErrorAt(`${SLOW}let a = slow("a", 100);\nlet b = slow("b", 1 ⟦/ 0);\nlet c = slow("c", 100);`);
    expect(outcome.output).toEqual(["a"]);
    expect(outcome.elapsed).toBe(100);
    expect(outcome.sleepCalls).toEqual([
      { startedAt: 0, ms: 100 },
      { startedAt: 0, ms: 100 },
    ]);
  });

  // Catches: an argument error in a later member lost when an earlier member fails first (the earlier one wins).
  test("with an argument error in member 2 and a failing callee in member 1, member 1 wins", async () => {
    const outcome = await expectRuntimeErrorAt(`${SLOW}fn boom() { sleep(5); return 1 ⟦/ 0; }\nlet a = boom();\nlet b = slow("b", 2 / 0);`);
    expect(outcome.output).toEqual([]);
  });

  // Catches: a wrong argument count not raised as that member's failure (or raised at the wrong place).
  test("an arity error is that member's failure, at its (", async () => {
    const outcome = await expectRuntimeErrorAt(`${SLOW}let a = slow("a", 100);\nlet b = slow⟦("b");\nlet c = slow("c", 50);`);
    expect(outcome.output).toEqual(["a"]);
    expect(outcome.elapsed).toBe(100);
  });

  // Catches: builtin member failures (bad sleep argument, unknown fetch key) unreported or sleeping anyway.
  test("builtin members fail like calls: sleep(-1) and an unknown fetch key", async () => {
    const negative = await expectRuntimeErrorAt("sleep(100);\nsleep⟦(-1);\nsleep(30);");
    expect(negative.output).toEqual([]);
    expect(negative.elapsed).toBe(100);
    expect(negative.sleepCalls).toEqual([
      { startedAt: 0, ms: 100 },
      { startedAt: 0, ms: 30 },
    ]);
    const io: IoTable = { ok: { value: 1, latencyMs: 40 } };
    const unknown = await expectRuntimeErrorAt(`${SLOW}let a = fetch⟦("nope");\nlet b = fetch("ok");\nlet c = slow("c", 5);`, io);
    expect(unknown.output).toEqual([]);
    expect(unknown.elapsed).toBe(40);
    expect(unknown.sleepCalls.map((call) => call.ms).sort((left, right) => left - right)).toEqual([5, 40]);
  });

  // Catches: the failure position taken from the call site instead of inside the function.
  test("an error inside the callee is located in the function's source text", async () => {
    const outcome = await expectRuntimeErrorAt(`fn bad() {\n  sleep(1);\n  return [1]⟦[3];\n}\nlet a = bad();\nlet b = bad();`);
    expect(outcome.output).toEqual([]);
  });

  // Catches: a recorded argument failure raised before the earlier members ran, or members after it still running.
  test("sequential fallback: members run in order, a recorded failure is raised at its turn, later members never run", async () => {
    const outcome = await expectRuntimeErrorAt(`${show}show([1]);\nshow(1 ⟦/ 0);\nshow([1, 2]);`);
    expect(outcome.output).toEqual(["1"]);
    expect(outcome.elapsed).toBe(10);
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });

  // Catches: argument evaluation skipped for the members of a run when an earlier member's arguments failed.
  test("step 2 evaluates every member's arguments even after one failed (an array in a later member forces the sequential path)", async () => {
    const outcome = await expectRuntimeErrorAt(`${show}let a = show(1 ⟦/ 0);\nlet b = show([1, 2]);`);
    expect(outcome.output).toEqual([]);
    expect(outcome.elapsed).toBe(0);
    expect(outcome.sleepCalls).toEqual([]);
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
  });
});

describe("final state equals sequential execution", () => {
  // Catches: let members initialized in completion order, or not at all before the next statement.
  test("each let member's variable holds its own call's value after the run, whatever the finishing order", async () => {
    const source = `${SLOW}let a = slow("a", 300);\nlet b = slow("b", 100);\nlet c = slow("c", 200);\nprint([a, b, c]);\nprint(a - b - c);`;
    await runsAs(source, { output: ["a", "b", "c", "[300, 100, 200]", "0"], elapsed: 300 });
  });

  // Catches: values of a run's lets unavailable to a following run's arguments.
  test("a following run uses the values of an earlier run", async () => {
    const source = `${SLOW}let a = slow("a", 100);\nlet b = slow("b", 200);\nlet gap = 0;\nlet c = slow("c", a + 50);\nlet d = slow("d", b - 50);\nprint(c + d);`;
    const outcome = await runsAs(source, { output: ["a", "b", "c", "d", "300"], elapsed: 200 + 150 });
    expect(outcome.sleepCalls.map((call) => [call.startedAt, call.ms])).toEqual([
      [0, 100],
      [0, 200],
      [200, 150],
      [200, 150],
    ]);
  });

  // Catches: a bare-call member's result leaking into a variable, or a nil result of a let member mishandled.
  test("a let member bound to a function without return holds nil; a bare call member has no variable", async () => {
    const source = "fn quiet(ms) { sleep(ms); }\nlet a = quiet(10);\nquiet(20);\nlet b = quiet(5);\nprint(a); print(b); print(a == b);";
    await runsAs(source, { output: ["nil", "nil", "true"], elapsed: 20 });
  });

  // Catches: a concurrent run in a loop re-using the previous iteration's values.
  test("a run in a loop body gives fresh variables per iteration", async () => {
    const source = `${SLOW}let seen = [];\nfor i in [1, 2, 3] {\n  let x = slow("x", i * 10);\n  let y = slow("y", i * 5);\n  push(seen, x + y);\n}\nprint(seen);`;
    await runsAs(source, { output: ["x", "y", "x", "y", "x", "y", "[15, 30, 45]"], elapsed: 10 + 20 + 30 });
  });

  // Catches: a member's callee seeing variables defined by an earlier run's lets (closure scope timing).
  test("a function called as a member reads current variables when it starts", async () => {
    const source = "let base = 1;\nfn read(ms) { sleep(ms); return base; }\nlet a = read(10);\nlet b = read(20);\nprint(a + b);";
    await runsAs(source, { output: ["2"], elapsed: 20 });
  });
});
