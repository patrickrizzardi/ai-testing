import { describe, expect, test } from "bun:test";
import { analyze } from ".";
import { lex } from "../syntax/lexer";
import { parse } from "../syntax/parser";

/** The program's top-level steps as text: `run:N` for a concurrent run of N members, `single` otherwise. */
function planOf(source: string): string[] {
  const parsed = parse(lex(source));
  if (!parsed.ok) throw new Error(`unexpected syntax error: ${parsed.error.message}`);
  const analysis = analyze(parsed.value);
  if (!analysis.ok) throw new Error(`unexpected static error: ${analysis.error.message}`);
  return analysis.value.stepsOf(parsed.value).map((step) => (step.kind === "concurrentRun" ? `run:${step.members.length}` : "single"));
}

/** Like `planOf`, for the statements of the then-block of the program's first `if`. */
function planOfFirstIfBlock(source: string): string[] {
  const parsed = parse(lex(source));
  if (!parsed.ok) throw new Error(`unexpected syntax error: ${parsed.error.message}`);
  const analysis = analyze(parsed.value);
  if (!analysis.ok) throw new Error(`unexpected static error: ${analysis.error.message}`);
  const statement = parsed.value.statements.find((candidate) => candidate.kind === "If");
  if (statement?.kind !== "If") throw new Error("the program has no if statement");
  return analysis.value.stepsOf(statement.thenBlock).map((step) => (step.kind === "concurrentRun" ? `run:${step.members.length}` : "single"));
}

const SLEEPER = "fn nap(ms) { sleep(ms); }\n";

describe("candidates and runs (spec 9.1)", () => {
  test("two independent builtin calls form a run", () => {
    expect(planOf("sleep(1); sleep(2);")).toEqual(["run:2"]);
  });

  test("a wait-prefixed statement is alone and ends the run", () => {
    expect(planOf("sleep(1); sleep(2); wait sleep(3); sleep(4); sleep(5);")).toEqual(["run:2", "single", "run:2"]);
  });

  test("a fn declaration or any other statement ends a run", () => {
    expect(planOf("sleep(1);\nfn f() { }\nsleep(2);")).toEqual(["single", "single", "single"]);
    expect(planOf("sleep(1); let x = 1; sleep(2);")).toEqual(["single", "single", "single"]);
  });

  test("an argument containing a call keeps the statement out of every run", () => {
    expect(planOf("fn one() { return 1; }\nsleep(one()); sleep(2); sleep(3);")).toEqual(["single", "single", "run:2"]);
  });

  test("a call that is parenthesised, assigned or not by name is not a candidate", () => {
    expect(planOf("let r = nil; (sleep(1)); sleep(2);")).toEqual(["single", "single", "single"]);
    expect(planOf("let r = nil; r = sleep(1); sleep(2);")).toEqual(["single", "single", "single"]);
  });

  test("a shadowed builtin name is not sleep", () => {
    expect(planOf("fn go(sleep) { sleep(1); sleep(2); }\nsleep(1); sleep(2);")).toEqual(["single", "run:2"]);
  });

  test("runs are found in blocks and function bodies too", () => {
    const parsed = parse(lex("if true { sleep(1); sleep(2); }"));
    if (!parsed.ok) throw new Error("syntax error");
    const analysis = analyze(parsed.value);
    if (!analysis.ok) throw new Error("static error");
    const statement = parsed.value.statements[0];
    if (statement?.kind !== "If") throw new Error("expected an if");
    expect(analysis.value.stepsOf(statement.thenBlock).map((step) => step.kind)).toEqual(["concurrentRun"]);
  });
});

describe("asynchronous functions (spec 8)", () => {
  test("asynchrony propagates through calls by name", () => {
    expect(planOf(`${SLEEPER}fn outer() { nap(1); }\nouter(); outer();`)).toEqual(["single", "single", "run:2"]);
  });

  test("mutual recursion alone does not make functions asynchronous", () => {
    expect(planOf("fn a() { b(); }\nfn b() { a(); }\na(); b();")).toEqual(["single", "single", "single", "single"]);
  });

  test("mutual recursion with a sleep in one of them makes both asynchronous", () => {
    expect(planOf("fn a() { sleep(1); b(); }\nfn b() { a(); }\na(); b();")).toEqual(["single", "single", "run:2"]);
  });

  test("a sleep in a nested function does not make the outer function asynchronous", () => {
    expect(planOf("fn outer() { fn inner() { sleep(1); } }\nouter(); outer();")).toEqual(["single", "single", "single"]);
  });
});

describe("containment (spec 8)", () => {
  test.each([
    ["an opaque call", "fn w(f) { sleep(1); f(); }\nfn noop() { }\nw(noop); w(noop);"],
    ["an opaque call in a called function", "fn call(f) { f(); }\nfn noop() { }\nfn w() { sleep(1); call(noop); }\nw(); w();"],
    ["an assignment to a non-local variable", "let n = 0;\nfn w() { sleep(1); n = 1; }\nw(); w();"],
    ["an index mutation of a non-local array", "let a = [0];\nfn w() { sleep(1); a[0] = 1; }\nw(); w();"],
    ["a push to a non-local array", "let a = [];\nfn w() { sleep(1); push(a, 1); }\nw(); w();"],
    ["a push through a field of a non-local record", "let r = {items: []};\nfn w() { sleep(1); push(r.items, 1); }\nw(); w();"],
    ["a mutation with no root", "fn make() { return [0]; }\nfn w() { sleep(1); make()[0] = 1; }\nw(); w();"],
    ["a push with no argument", "fn w() { sleep(1); push(); }\nw(); w();"],
    ["a mutation in one function and a non-local read in another it calls", "let k = 1;\nfn read() { return k; }\nfn w() { let a = [0]; sleep(1); a[0] = read(); }\nw(); w();"],
  ])("a function with %s is not contained", (_label, source) => {
    expect(planOf(source).filter((step) => step.startsWith("run"))).toEqual([]);
  });

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
  test("a member that uses a name an earlier member defines depends on it", () => {
    expect(planOf(`${SLEEPER}let a = nap(1); let b = nap(a);`)).toEqual(["single", "single", "single"]);
  });

  test("sharing a used name is not a dependency", () => {
    expect(planOf(`${SLEEPER}let delay = 5; nap(delay); nap(delay);`)).toEqual(["single", "single", "run:2"]);
  });

  test("a non-adjacent dependency makes the whole run sequential", () => {
    expect(planOf(`${SLEEPER}let a = nap(1); let b = nap(2); let c = nap(a);`)).toEqual(["single", "single", "single", "single"]);
  });

  test("names are compared by name, not by declaration: a shadowing definition conflicts with a name the callee reads", () => {
    const source = "let shared = 1;\nfn read() { sleep(shared); }\nfn outer() { read(); }\nif true { let shared = outer(); let other = outer(); }";
    expect(planOfFirstIfBlock(source)).toEqual(["single", "single"]);
  });

  test("a name read only by a nested function the callee never calls is not a use", () => {
    const source = "let k = 1;\nfn w() { fn unused() { return k; } sleep(1); }\nif true { let k = w(); let other = w(); }";
    expect(planOfFirstIfBlock(source)).toEqual(["run:2"]);
  });

  test("the same name read by a nested function the callee does call is a use", () => {
    const source = "let k = 1;\nfn w() { fn used() { return k; } used(); sleep(1); }\nif true { let k = w(); let other = w(); }";
    expect(planOfFirstIfBlock(source)).toEqual(["single", "single"]);
  });

  test("builtin names are neither defined nor used", () => {
    expect(planOf('let a = fetch("x"); let b = fetch("y");')).toEqual(["run:2"]);
  });
});
