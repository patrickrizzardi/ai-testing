import { describe, expect, test } from "bun:test";
import type { Step } from ".";
import { analysisOf } from "../test-support";

/** Steps as text: `run:N` for a concurrent run of N members, `single` otherwise. */
function describeSteps(steps: readonly Step[]): string[] {
  return steps.map((step) => (step.kind === "concurrentRun" ? `run:${step.members.length}` : "single"));
}

/** The program's top-level steps as text. */
function planOf(source: string): string[] {
  const { program, analysis } = analysisOf(source);
  return describeSteps(analysis.stepsOf(program));
}

/** Like `planOf`, for the statements of the then-block of the program's first `if`. */
function planOfFirstIfBlock(source: string): string[] {
  const { program, analysis } = analysisOf(source);
  const statement = program.statements.find((candidate) => candidate.kind === "If");
  if (statement?.kind !== "If") throw new Error("the program has no if statement");
  return describeSteps(analysis.stepsOf(statement.thenBlock));
}

const SLEEPER = "fn nap(ms) { sleep(ms); }\n";

describe("candidates and runs (spec 9.1)", () => {
  // Bug: independent calls left sequential, so the program loses its concurrency. Tier: High (run eligibility decides output order and variable values).
  test("two independent builtin calls form a run", () => {
    expect(planOf("sleep(1); sleep(2);")).toEqual(["run:2"]);
  });

  // Bug: a run extending across a `wait`, or `wait` ignored. Tier: High (run eligibility decides output order and variable values).
  test("a wait-prefixed statement is alone and ends the run", () => {
    expect(planOf("sleep(1); sleep(2); wait sleep(3); sleep(4); sleep(5);")).toEqual(["run:2", "single", "run:2"]);
  });

  // Bug: a run extending across a statement that is not a candidate. Tier: High (run eligibility decides output order and variable values).
  test("a fn declaration or any other statement ends a run", () => {
    expect(planOf("sleep(1);\nfn f() { }\nsleep(2);")).toEqual(["single", "single", "single"]);
    expect(planOf("sleep(1); let x = 1; sleep(2);")).toEqual(["single", "single", "single"]);
  });

  // Bug: a statement whose argument holds a call joining a run, so the nested call runs out of order. Tier: High (run eligibility decides output order and variable values).
  test("an argument containing a call keeps the statement out of every run", () => {
    expect(planOf("fn one() { return 1; }\nsleep(one()); sleep(2); sleep(3);")).toEqual(["single", "single", "run:2"]);
  });

  // Bug: a parenthesised or assigned call taken as a run member. Tier: High (run eligibility decides output order and variable values).
  test("a call that is parenthesised, assigned or not by name is not a candidate", () => {
    expect(planOf("let r = nil; (sleep(1)); sleep(2);")).toEqual(["single", "single", "single"]);
    expect(planOf("let r = nil; r = sleep(1); sleep(2);")).toEqual(["single", "single", "single"]);
  });

  // Bug: a parameter named `sleep` treated as the builtin (names resolved by text, not by declaration). Tier: High (run eligibility decides output order and variable values).
  test("a shadowed builtin name is not sleep", () => {
    expect(planOf("fn go(sleep) { sleep(1); sleep(2); }\nsleep(1); sleep(2);")).toEqual(["single", "run:2"]);
  });

});

describe("asynchronous functions (spec 8)", () => {
  // Bug: asynchrony not passed to callers, so calls of wrapper functions never run concurrently. Tier: High (asynchrony decides run eligibility).
  test("asynchrony propagates through calls by name", () => {
    expect(planOf(`${SLEEPER}fn outer() { nap(1); }\nouter(); outer();`)).toEqual(["single", "single", "run:2"]);
  });

  // Bug: a greatest instead of a least solution: functions that only call each other taken as asynchronous. Tier: High (asynchrony decides run eligibility).
  test("mutual recursion alone does not make functions asynchronous", () => {
    expect(planOf("fn a() { b(); }\nfn b() { a(); }\na(); b();")).toEqual(["single", "single", "single", "single"]);
  });

  // Bug: asynchrony reaching only one function of a cycle. Tier: High (asynchrony decides run eligibility).
  test("mutual recursion with a sleep in one of them makes both asynchronous", () => {
    expect(planOf("fn a() { sleep(1); b(); }\nfn b() { a(); }\na(); b();")).toEqual(["single", "single", "run:2"]);
  });

  // Bug: a nested function's `sleep` credited to its parent. Tier: High (asynchrony decides run eligibility).
  test("a sleep in a nested function does not make the outer function asynchronous", () => {
    expect(planOf("fn outer() { fn inner() { sleep(1); } }\nouter(); outer();")).toEqual(["single", "single", "single"]);
  });
});

describe("containment (spec 8)", () => {
  // Bug: a function the spec calls not contained run concurrently, racing on shared state. Tier: High (containment decides run eligibility).
  test.each([
    ["an opaque call", "fn w(f) { sleep(1); f(); }\nfn noop() { }\nw(noop); w(noop);"],
    ["an opaque call in a called function", "fn call(f) { f(); }\nfn noop() { }\nfn w() { sleep(1); call(noop); }\nw(); w();"],
    ["an assignment to a non-local variable", "let n = 0;\nfn w() { sleep(1); n = 1; }\nw(); w();"],
    ["an index mutation of a non-local array", "let a = [0];\nfn w() { sleep(1); a[0] = 1; }\nw(); w();"],
    ["a field mutation of a non-local record", "let r = {n: 0};\nfn w() { sleep(1); r.n = 1; }\nw(); w();"],
    ["a push to a non-local array", "let a = [];\nfn w() { sleep(1); push(a, 1); }\nw(); w();"],
    ["a push through a field of a non-local record", "let r = {items: []};\nfn w() { sleep(1); push(r.items, 1); }\nw(); w();"],
    ["a mutation with no root", "fn make() { return [0]; }\nfn w() { sleep(1); make()[0] = 1; }\nw(); w();"],
    ["a mutation through a parenthesised base", "fn w() { let r = {}; sleep(1); (r).n = 1; }\nw(); w();"],
    ["a push with no argument", "fn w() { sleep(1); push(); }\nw(); w();"],
    ["an opaque call in an else-if condition", "fn w(f) { sleep(1); if false { } else if f() { } }\nfn noop() { return true; }\nw(noop); w(noop);"],
    ["a mutation in one function and a non-local read in another it calls", "let k = 1;\nfn read() { return k; }\nfn w() { let a = [0]; sleep(1); a[0] = read(); }\nw(); w();"],
  ])("a function with %s is not contained", (_label, source) => {
    expect(planOf(source).filter((step) => step.startsWith("run"))).toEqual([]);
  });

  // Bug: a contained function refused, losing concurrency. Tier: High (containment decides run eligibility).
  test.each([
    ["a mutation of a local array", "fn w() { let a = [0]; sleep(1); a[0] = 1; push(a, 2); }\nw(); w();"],
    ["a mutation of a parameter", "fn w(items) { sleep(1); }\nfn v() { let items = []; sleep(1); push(items, 1); }\nv(); v();"],
    ["a non-local read without any mutation", "let k = 1;\nfn w() { sleep(1); return k; }\nw(); w();"],
    ["a nested function's own opaque call and assignment", "fn w() { fn inner(f) { f(); } let n = 0; fn bump() { n = 1; } sleep(1); }\nw(); w();"],
    ["a call to a function declared elsewhere by name", "fn helper() { return 1; }\nfn w() { sleep(1); return helper(); }\nw(); w();"],
  ])("a function with %s is contained", (_label, source) => {
    expect(planOf(source)).toContain("run:2");
  });
});

describe("independence (spec 9.2)", () => {
  // Bug: a member reading a name an earlier member defines run beside it, reading the value too early. Tier: High (independence decides output order and variable values).
  test("a member that uses a name an earlier member defines depends on it", () => {
    expect(planOf(`${SLEEPER}let a = nap(1); let b = nap(a);`)).toEqual(["single", "single", "single"]);
  });

  // Bug: two members that only read the same name taken as dependent, losing concurrency. Tier: High (independence decides output order and variable values).
  test("sharing a used name is not a dependency", () => {
    expect(planOf(`${SLEEPER}let delay = 5; nap(delay); nap(delay);`)).toEqual(["single", "single", "run:2"]);
  });

  // Bug: only adjacent members compared, so a later dependency runs concurrently. Tier: High (independence decides output order and variable values).
  test("a non-adjacent dependency makes the whole run sequential", () => {
    expect(planOf(`${SLEEPER}let a = nap(1); let b = nap(2); let c = nap(a);`)).toEqual(["single", "single", "single", "single"]);
  });

  // Bug: names compared by declaration, so a shadowing definition escapes the conflict with what the callee reads (spec 9.2 compares by name). Tier: High (independence decides output order and variable values).
  test("names are compared by name, not by declaration: a shadowing definition conflicts with a name the callee reads", () => {
    const source = "let shared = 1;\nfn read() { sleep(shared); }\nfn outer() { read(); }\nif true { let shared = outer(); let other = outer(); }";
    expect(planOfFirstIfBlock(source)).toEqual(["single", "single"]);
  });

  // Bug: every nested function's names counted as used, though the callee never reaches them. Tier: High (independence decides output order and variable values).
  test("a name read only by a nested function the callee never calls is not a use", () => {
    const source = "let k = 1;\nfn w() { fn unused() { return k; } sleep(1); }\nif true { let k = w(); let other = w(); }";
    expect(planOfFirstIfBlock(source)).toEqual(["run:2"]);
  });

  // Bug: names of functions in `reach` left out of the callee's uses. Tier: High (independence decides output order and variable values).
  test("the same name read by a nested function the callee does call is a use", () => {
    const source = "let k = 1;\nfn w() { fn used() { return k; } used(); sleep(1); }\nif true { let k = w(); let other = w(); }";
    expect(planOfFirstIfBlock(source)).toEqual(["single", "single"]);
  });

  // Bug: the builtin name `fetch` counted as a use, so two fetches conflict. Tier: High (independence decides output order and variable values).
  test("builtin names are neither defined nor used", () => {
    expect(planOf('let a = fetch("x"); let b = fetch("y");')).toEqual(["run:2"]);
  });
});
