// Spec section 12 (examples), verbatim. These are the spec's own worked
// examples; concurrency examples 12.5 live in concurrency.test.ts.
import { describe, expect, test } from "bun:test";
import { exec, expectRuntimeErrorAt, expectSyntaxErrorAt } from "./harness.ts";

describe("spec 12.1-12.3 programs", () => {
  // Catches: any divergence on the spec's reference arithmetic/display/loop program (output and heap).
  test("12.1 arithmetic, display, loops", async () => {
    const source = `let x = 7;
let y = -2;
print(x / y);
print(x % y);
print("n=" + "7");
print([1, "a\\"b", true, nil, [2], {k: 3}]);
let items = [];
let i = 0;
while i < 4 {
  push(items, i * i);
  i = i + 1;
}
let sum = 0;
for v in items { sum = sum + v; }
print(items);
print(sum);`;
    const outcome = await exec(source);
    expect(outcome.output).toEqual(["-3", "1", "n=7", '[1, "a\\"b", true, nil, [2], {k: 3}]', "[0, 1, 4, 9]", "14"]);
    expect(outcome.error).toBeNull();
    expect(outcome.heap).toEqual({ allocs: 4, frees: 4 });
  });

  // Catches: closure/counter/recursion semantics and the cells allocation kept alive by a closure.
  test("12.2 closures and recursion", async () => {
    const source = `fn fact(n) {
  if n <= 1 { return 1; }
  return n * fact(n - 1);
}
fn makeCounter() {
  let cells = [0];
  fn next() {
    cells[0] = cells[0] + 1;
    return cells[0];
  }
  return next;
}
let tick = makeCounter();
tick();
print(tick());
print(fact(10));
print(tick);`;
    const outcome = await exec(source);
    expect(outcome.output).toEqual(["2", "3628800", "<fn next>"]);
    expect(outcome.error).toBeNull();
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
  });

  // Catches: record insertion order, keys, len and && on the spec's records program.
  test("12.3 records", async () => {
    const source = `let r = {b: 2, a: 1};
r.c = r.a + r.b;
for k in keys(r) {
  print(k);
}
print(r);
print(len(r) == 3 && r.c == 3);`;
    const outcome = await exec(source);
    expect(outcome.output).toEqual(["b", "a", "c", "{b: 2, a: 1, c: 3}", "true"]);
    expect(outcome.error).toBeNull();
    expect(outcome.heap).toEqual({ allocs: 2, frees: 2 });
  });
});

describe("spec 12.4 errors", () => {
  test("`let x = ;` is a SyntaxError at the ;", async () => {
    await expectSyntaxErrorAt("let x = ⟦;");
  });

  test("`if true {` is a SyntaxError at EOF (line 1, column 10)", async () => {
    const outcome = await exec("if true {");
    expect(outcome.error).toMatchObject({ kind: "SyntaxError", line: 1, column: 10 });
  });

  test('`print("abc);` is a SyntaxError at the opening quote (column 7)', async () => {
    const outcome = await exec('print("abc);');
    expect(outcome.error).toMatchObject({ kind: "SyntaxError", line: 1, column: 7 });
  });

  test("a repeated let is a SyntaxError at the second name (line 2, column 5)", async () => {
    const outcome = await exec("let a = 1;\nlet a = 2;");
    expect(outcome.error).toMatchObject({ kind: "SyntaxError", line: 2, column: 5 });
    expect(outcome.output).toEqual([]);
    expect(outcome.heap).toEqual({ allocs: 0, frees: 0 });
  });

  test("`1 + 2 = 3;` is a SyntaxError at the = (column 7)", async () => {
    const outcome = await exec("1 + 2 = 3;");
    expect(outcome.error).toMatchObject({ kind: "SyntaxError", line: 1, column: 7 });
  });

  test("index out of range is a RuntimeError at the [ (line 2, column 8), output [], heap 1/1", async () => {
    const outcome = await exec("let a = [1, 2];\nprint(a[2]);");
    expect(outcome.error).toMatchObject({ kind: "RuntimeError", line: 2, column: 8 });
    expect(outcome.output).toEqual([]);
    expect(outcome.heap).toEqual({ allocs: 1, frees: 1 });
  });

  test("division by zero is a RuntimeError at the / (line 2, column 9), output keeps the earlier print", async () => {
    const outcome = await exec("print(1);\nprint(1 / 0);");
    expect(outcome.error).toMatchObject({ kind: "RuntimeError", line: 2, column: 9 });
    expect(outcome.output).toEqual(["1"]);
  });

  // Catches: a RuntimeError reported with SyntaxError's clean-slate rules (output dropped).
  test("a RuntimeError keeps the output printed before it (marker form)", async () => {
    const outcome = await expectRuntimeErrorAt('print("a");\nprint("b");\nprint(nil ⟦+ 1);');
    expect(outcome.output).toEqual(["a", "b"]);
  });
});
