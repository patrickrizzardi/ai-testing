// Spec sections 6.2-6.4, 7 and 11: literals, index/field, calls, statements,
// builtins, evaluation order and runtime error positions. Tier: Medium for
// the flows, High where the spec fixes an exact position or limit.
import { describe, expect, test } from "bun:test";
import { exec, execWithRejectingClock, expectOk, expectRuntimeErrorAt } from "./harness.ts";

const SAY = 'fn say(label, v) { print(label); return v; }\n';

describe("literals, index and field (6.2)", () => {
  // Catches: array/record literal built before all element expressions evaluated, or in the wrong order.
  test("literal elements and fields are evaluated left to right", async () => {
    const outcome = await expectOk(SAY + 'print([say("a", 1), say("b", 2)]); print({x: say("c", 3), y: say("d", 4)});');
    expect(outcome.output).toEqual(["a", "b", "[1, 2]", "c", "d", "{x: 3, y: 4}"]);
  });

  // Catches: index evaluated before the base, bounds checked before both operands are evaluated.
  test("a[i] evaluates a then i, then checks", async () => {
    const outcome = await expectOk(SAY + 'print(say("base", [10, 20, 30])[say("index", 1)]);');
    expect(outcome.output).toEqual(["base", "index", "20"]);
    const failing = await expectRuntimeErrorAt(SAY + 'print(say("base", [1])⟦[say("index", 5)]);');
    expect(failing.output).toEqual(["base", "index"]);
  });

  const indexErrors: [string, string][] = [
    ["index equal to length", "let a = [1, 2]; print(a⟦[2]);"],
    ["negative index", "let a = [1, 2]; print(a⟦[-1]);"],
    ["index on empty array", "print([]⟦[0]);"],
    ["string index", 'let a = [1]; print(a⟦["0"]);'],
    ["boolean index", "let a = [1]; print(a⟦[true]);"],
    ["nil index", "let a = [1]; print(a⟦[nil]);"],
    ["array index", "let a = [1]; print(a⟦[[0]]);"],
    ["indexing a string", 'print("abc"⟦[0]);'],
    ["indexing a record", 'print({a: 1}⟦["a"]);'],
    ["indexing nil", "print(nil⟦[0]);"],
    ["indexing an integer", "print(5⟦[0]);"],
    ["second index of a chain", "let a = [[1]]; print(a[0]⟦[1]);"],
    ["indexing a function", "fn f() { }\nprint(f⟦[0]);"],
  ];
  for (const [rule, template] of indexErrors) {
    // Catches: JS array semantics (undefined for out of range, string indexing) instead of a RuntimeError at [.
    test(`indexing error at the [ token: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  // Catches: first/last index mishandled.
  test("valid indices run 0..len-1", async () => {
    expect((await expectOk("let a = [5, 6, 7]; print(a[0]); print(a[2]); print(a[1 + 1]);")).output).toEqual(["5", "7", "7"]);
  });

  const fieldErrors: [string, string][] = [
    ["missing field", "let r = {a: 1}; print(r⟦.b);"],
    ["field of an empty record", "print({}⟦.a);"],
    ["field of an array", "print([1]⟦.a);"],
    ["field of a string", 'print("s"⟦.length);'],
    ["field of nil", "print(nil⟦.a);"],
    ["field of an integer", "print(5⟦.a);"],
    ["second field of a chain", "let r = {a: {b: 1}}; print(r.a⟦.c);"],
    ["field of a function", "fn f() { }\nprint(f⟦.name);"],
    ["inherited JS member: constructor", "let r = {}; print(r⟦.constructor);"],
    ["inherited JS member: toString", "let r = {a: 1}; print(r⟦.toString);"],
    ["inherited JS member: hasOwnProperty", "let r = {}; print(r⟦.hasOwnProperty);"],
    ["inherited JS member: __proto__", "let r = {}; print(r⟦.__proto__);"],
    ["field of a field that is nil", "let r = {a: nil}; print(r.a⟦.b);"],
  ];
  for (const [rule, template] of fieldErrors) {
    // Catches: undefined/prototype members leaking as fields; error at the field name instead of the dot.
    test(`field read error at the . token: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  // Catches: a plain-object record losing keys named like Object.prototype members.
  test("records hold any identifier as a field name, including __proto__, constructor and toString", async () => {
    const source = [
      "let r = {__proto__: 1, constructor: 2, toString: 3, hasOwnProperty: 4};",
      "print(r.__proto__); print(r.constructor); print(r.toString); print(r.hasOwnProperty);",
      "print(r); print(keys(r)); print(len(r));",
      "let s = {};",
      "s.__proto__ = 5;",
      "s.valueOf = 6;",
      "print(s); print(s.__proto__); print(len(s)); print(s == {__proto__: 5, valueOf: 6});",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual([
      "1",
      "2",
      "3",
      "4",
      "{__proto__: 1, constructor: 2, toString: 3, hasOwnProperty: 4}",
      '["__proto__", "constructor", "toString", "hasOwnProperty"]',
      "4",
      "{__proto__: 5, valueOf: 6}",
      "5",
      "2",
      "true",
    ]);
  });
});

describe("assignment (6.4)", () => {
  // Catches: the right side evaluated after the target pieces, or checks done before all three are evaluated.
  test("a[i] = e evaluates a, i, e in that order, then checks and stores", async () => {
    const outcome = await expectOk(SAY + 'let arr = [0, 0]; say("a", arr)[say("i", 1)] = say("e", 9); print(arr);');
    expect(outcome.output).toEqual(["a", "i", "e", "[0, 9]"]);
  });

  // Catches: bounds/type check before the right side is evaluated.
  test("a failing index assignment still evaluates the right side first", async () => {
    const outcome = await expectRuntimeErrorAt(SAY + 'let arr = [0];\narr⟦[5] = say("rhs", 1);');
    expect(outcome.output).toEqual(["rhs"]);
    const wrongBase = await expectRuntimeErrorAt(SAY + '5⟦[0] = say("rhs", 1);');
    expect(wrongBase.output).toEqual(["rhs"]);
  });

  const indexAssignErrors: [string, string][] = [
    ["index equal to length (cannot grow)", "let a = [1]; a⟦[1] = 2;"],
    ["negative index", "let a = [1]; a⟦[-1] = 2;"],
    ["non-integer index", 'let a = [1]; a⟦["0"] = 2;'],
    ["string base", 'let s = "abc"; s⟦[0] = "x";'],
    ["record base", "let r = {}; r⟦[0] = 1;"],
    ["nil base", "let n = nil; n⟦[0] = 1;"],
    ["empty array", "let a = []; a⟦[0] = 1;"],
  ];
  for (const [rule, template] of indexAssignErrors) {
    // Catches: index assignment growing the array or accepting non-arrays.
    test(`index assignment error at the [ token: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  // Catches: field assignment checking the base before evaluating the right side, or accepting non-records.
  test("r.f = e evaluates r then e, then requires a record", async () => {
    const ok = await expectOk(SAY + 'let r = {}; say("r", r).f = say("e", 1); print(r);');
    expect(ok.output).toEqual(["r", "e", "{f: 1}"]);
    const bad = await expectRuntimeErrorAt(SAY + "let n = 5;\nn⟦.f = say(\"e\", 1);");
    expect(bad.output).toEqual(["e"]);
    await expectRuntimeErrorAt("let a = [1]; a⟦.f = 1;");
    await expectRuntimeErrorAt("let s = nil; s⟦.f = 1;");
  });

  // Catches: reassigning an existing field moving it to the end, or a new field not appended.
  test("a new field is appended to the insertion order; an existing field keeps its place", async () => {
    const source = "let r = {a: 1, b: 2}; r.a = 10; r.c = 3; r.b = 20; print(r); print(keys(r));";
    expect((await expectOk(source)).output).toEqual(["{a: 10, b: 20, c: 3}", '["a", "b", "c"]']);
  });

  // Catches: x = e storing before evaluating e, or storing into the wrong binding.
  test("x = e evaluates e first, then stores into the binding x resolves to", async () => {
    const source = SAY + "let x = 1; x = say(\"e\", x + 1); print(x);";
    expect((await expectOk(source)).output).toEqual(["e", "2"]);
    const unresolved = await expectRuntimeErrorAt(SAY + '⟦missing = say("e", 1);');
    expect(unresolved.output).toEqual(["e"]);
  });

  // Catches: copying on assignment.
  test("arrays and records are shared by reference when assigned or passed", async () => {
    const source = [
      "let a = [1]; let b = a; push(b, 2); print(a);",
      "let r = {k: 1}; let s = r; s.k = 5; print(r.k);",
      "fn touch(x) { push(x, 99); x[0] = 7; } touch(a); print(a);",
      "let nested = [a, r]; nested[0][0] = 0; print(a);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["[1, 2]", "5", "[7, 2, 99]", "[0, 2, 99]"]);
  });

  // Catches: an expression statement result kept or its errors skipped.
  test("an expression statement is evaluated and discarded; its errors count", async () => {
    expect((await expectOk('1 + 2; "s"; nil; [1, 2]; {a: 1};')).output).toEqual([]);
    await expectRuntimeErrorAt("1 ⟦/ 0;");
    await expectRuntimeErrorAt("⟦missing;");
  });
});

describe("conditions and loops (6.4, 11)", () => {
  const badConditions: [string, string][] = [
    ["if with an integer", "if ⟦1 { }"],
    ["if with nil", "if ⟦nil { }"],
    ["if with a string", 'if ⟦"yes" { }'],
    ["if with an array", "if ⟦[] { }"],
    ["if with a parenthesized sum: first token is the (", "if ⟦(1 + 2) { }"],
    ["if with a call: first token is the callee", "fn f() { return 1; }\nif ⟦f() { }"],
    ["if with a unary minus", "if ⟦-1 { }"],
    ["if with a field read", "let r = {a: 1}; if ⟦r.a { }"],
    ["else if", "if false { } else if ⟦5 { }"],
    ["while at the first check", "while ⟦0 { }"],
    ["while on a later iteration", "let go = true;\nwhile ⟦go {\n  go = 1;\n}"],
    ["if on a later line, indented", "let a = 1;\n\n    if    ⟦a { }"],
  ];
  for (const [rule, template] of badConditions) {
    // Catches: truthy coercion of conditions, or the error at the keyword / last token of the condition.
    test(`a non-boolean condition is a RuntimeError at the condition's first token: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  const badIterables: [string, string][] = [
    ["integer", "for x in ⟦5 { }"],
    ["string", 'for x in ⟦"abc" { }'],
    ["nil", "for x in ⟦nil { }"],
    ["record", "for x in ⟦{a: 1} { }"],
    ["parenthesized sum: first token is the (", "for x in ⟦(1 + 2) { }"],
    ["call result", "fn f() { return 1; }\nfor x in ⟦f() { }"],
    ["field read", "let r = {a: 1}; for x in ⟦r.a { }"],
    ["boolean", "for x in ⟦true { }"],
    ["unary minus", "for x in ⟦-1 { }"],
  ];
  for (const [rule, template] of badIterables) {
    // Catches: iterating strings/records or locating the error at `for`/`in`.
    test(`for over a non-array is a RuntimeError at the iterable's first token: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  // Catches: elements pushed during the loop skipped (length read once) or iterated length stale.
  test("for visits elements pushed during the loop: the current length is read before each iteration", async () => {
    const source = "let a = [1]; for v in a { if len(a) < 5 { push(a, v + 1); } } print(a);";
    expect((await expectOk(source)).output).toEqual(["[1, 2, 3, 4, 5]"]);
    const doubling = "let q = [1, 2]; let seen = []; for v in q { push(seen, v); if v < 3 { push(q, v + 2); } } print(seen);";
    expect((await expectOk(doubling)).output).toEqual(["[1, 2, 3, 4]"]);
  });

  // Catches: the iterable re-evaluated per iteration, or the loop following a reassigned variable.
  test("the iterable expression is evaluated once, and reassigning the variable does not change the loop", async () => {
    const source = SAY + 'for v in say("once", [1, 2]) { print(v); }\nlet a = [1, 2]; for v in a { a = [9]; print(v); }';
    expect((await expectOk(source)).output).toEqual(["once", "1", "2", "1", "2"]);
  });

  // Catches: the element captured at loop start instead of read at each iteration.
  test("the element is read when its iteration starts: an earlier body can change a later element", async () => {
    const source = "let a = [1, 2, 3]; for v in a { if v == 1 { a[2] = 30; } print(v); }";
    expect((await expectOk(source)).output).toEqual(["1", "2", "30"]);
  });

  // Catches: an empty array running the body, or a loop variable leaking out.
  test("an empty array runs no iteration, and the loop variable is not visible after the loop", async () => {
    expect((await expectOk("for v in [] { print(1); } print(2);")).output).toEqual(["2"]);
    await expectRuntimeErrorAt("for v in [1] { }\nprint(⟦v);");
  });

  // Catches: return inside a loop only leaving the loop; while evaluating the condition once.
  test("return inside loops leaves the function; the while condition is re-evaluated each iteration", async () => {
    const source = [
      "fn firstBig(items) { for v in items { while true { if v > 1 { return v; } return 0; } } return -1; }",
      "print(firstBig([1, 5, 9])); print(firstBig([])); print(firstBig([7]));",
      "let n = 0; let log = [];",
      "while n < 3 { push(log, n); n = n + 1; }",
      "print(log);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["0", "-1", "7", "[0, 1, 2]"]);
  });
});

describe("calls (6.3)", () => {
  // Catches: arguments evaluated before the callee, or the callee check done before the arguments.
  test("callee first, then arguments left to right, then the checks", async () => {
    const source = [
      SAY,
      "fn three(a, b, c) { return a + b + c; }",
      'fn pick() { print("callee"); return three; }',
      'print(pick()(say("x", 1), say("y", 2), say("z", 3)));',
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["callee", "x", "y", "z", "6"]);
  });

  // Catches: an unresolved callee's arguments evaluated anyway (the callee error comes first).
  test("an unresolved callee fails before any argument is evaluated, at the identifier", async () => {
    const outcome = await expectRuntimeErrorAt(SAY + '⟦missing(say("arg", 1));');
    expect(outcome.output).toEqual([]);
  });

  // Catches: callee type check before argument evaluation.
  test("calling a non-function: the arguments are evaluated, then RuntimeError at the (", async () => {
    const outcome = await expectRuntimeErrorAt(SAY + 'let x = 1;\nx⟦(say("arg", 1));');
    expect(outcome.output).toEqual(["arg"]);
    await expectRuntimeErrorAt('"s"⟦();');
    await expectRuntimeErrorAt("nil⟦();");
    await expectRuntimeErrorAt("let a = [print]; a⟦();");
    await expectRuntimeErrorAt("let r = {f: 1}; r.f⟦();");
  });

  // Catches: arity not checked, or checked before the arguments are evaluated.
  test("wrong argument count: arguments are evaluated first, then RuntimeError at the (", async () => {
    const outcome = await expectRuntimeErrorAt(SAY + "fn two(a, b) { }\ntwo⟦(say(\"a\", 1));");
    expect(outcome.output).toEqual(["a"]);
    await expectRuntimeErrorAt("fn none() { }\nnone⟦(1);");
    await expectRuntimeErrorAt("fn one(a) { }\none⟦();");
    await expectRuntimeErrorAt("fn one(a) { }\none⟦(1, 2);");
  });

  // Catches: the returned value taken from the last statement, or return; yielding something other than nil.
  test("the first return executed gives the value; a body without return gives nil; return; gives nil", async () => {
    const source = [
      "fn first() { return 1; return 2; }",
      "fn none() { let x = 1; }",
      "fn bare() { return; }",
      "fn early(n) { if n > 0 { return \"pos\"; } print(\"after-if\"); return \"nonpos\"; }",
      "print(first()); print(none()); print(bare()); print(early(1)); print(early(0));",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["1", "nil", "nil", "pos", "after-if", "nonpos"]);
  });

  // Catches: a callee's variables leaking into the caller, or recursion sharing one scope.
  test("each call has its own scope: recursion and repeated calls do not share locals", async () => {
    const source = [
      "fn fact(n) { if n <= 1 { return 1; } let sub = fact(n - 1); return n * sub; }",
      "fn counter() { let c = 0; c = c + 1; return c; }",
      "print(fact(10)); print(counter()); print(counter());",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["3628800", "1", "1"]);
  });

  // Catches: counters sharing state between closures from different calls.
  test("closures from different calls have independent captured scopes", async () => {
    const source = [
      "fn makeCounter() { let cells = [0]; fn next() { cells[0] = cells[0] + 1; return cells[0]; } return next; }",
      "let a = makeCounter(); let b = makeCounter();",
      "a(); a(); b();",
      "print(a()); print(b());",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["3", "2"]);
  });

  // Catches: an off-by-one in the depth limit (depth 200 allowed, 201 an error).
  test("call depth 200 is allowed", async () => {
    const source = "fn down(n) { if n == 0 { return 0; } return 1 + down(n - 1); }\nprint(down(199));\nprint(down(199));";
    expect((await expectOk(source)).output).toEqual(["199", "199"]);
  });

  // Catches: the depth limit missing (stack overflow), off by one, or located elsewhere than the call's (.
  test("a call of depth 201 is a RuntimeError at the (, and the output so far is kept", async () => {
    const source = "fn down(n) { if n == 0 { return 0; } return 1 + down⟦(n - 1); }\nprint(down(199));\nprint(down(200));";
    const outcome = await expectRuntimeErrorAt(source);
    expect(outcome.output).toEqual(["199"]);
  });

  // Catches: unbounded recursion hanging or crashing the host instead of a RuntimeError.
  test("infinite recursion ends with a RuntimeError at the recursive call", async () => {
    const outcome = await expectRuntimeErrorAt("fn forever() { return forever⟦(); }\nforever();");
    expect(outcome.output).toEqual([]);
    await expectRuntimeErrorAt("fn ping() { pong(); }\nfn pong() { ping⟦(); }\nping();");
  });

  // Catches: depth counting builtin calls or the program itself.
  test("the depth is the number of active user-function calls: builtins and sequential calls do not add", async () => {
    const source = [
      "fn leaf() { return len([1]); }",
      "fn spread(n) { let total = 0; let i = 0; while i < n { total = total + leaf(); i = i + 1; } return total; }",
      "print(spread(300));",
      "fn nest(n) { if n == 0 { return 0; } return nest(n - 1); }",
      "print(nest(150) + nest(150));",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["300", "0"]);
  });

  // Catches: depth counted through closures/variable calls wrongly (a closure call is a user-function call).
  test("calls through variables and closures count towards the depth", async () => {
    const source = "fn viaVar(n) { let self = viaVar; if n == 0 { return 0; } return self⟦(n - 1); }\nprint(viaVar(10));\nprint(viaVar(300));";
    const outcome = await expectRuntimeErrorAt(source);
    expect(outcome.output).toEqual(["0"]);
  });

  // Catches: an error inside a function reported at the call site or at line 1.
  test("an error inside a function is located in the function's source text", async () => {
    const source = "print(1);\n\nfn broken(list) {\n  return list⟦[3];\n}\n\nprint(broken([1]));";
    const outcome = await expectRuntimeErrorAt(source);
    expect(outcome.output).toEqual(["1"]);
  });

  // Catches: a runtime error swallowed by an enclosing call, loop or concurrency run.
  test("a runtime error stops everything at once: no later statement, loop iteration or output", async () => {
    const source = SAY + "fn f() { say(\"in-f\", 1); 1 ⟦/ 0; say(\"never-1\", 1); }\nfor i in [1, 2] { f(); say(\"never-2\", 1); }\nsay(\"never-3\", 1);";
    const outcome = await expectRuntimeErrorAt(source);
    expect(outcome.output).toEqual(["in-f"]);
  });
});

describe("builtins (7)", () => {
  const argumentErrors: [string, string][] = [
    ["print() without arguments", "print⟦();"],
    ["print with two arguments", "print⟦(1, 2);"],
    ["len with no arguments", "len⟦();"],
    ["len with two arguments", "len⟦([], 1);"],
    ["len of an integer", "len⟦(5);"],
    ["len of nil", "len⟦(nil);"],
    ["len of a boolean", "len⟦(true);"],
    ["len of a function", "len⟦(print);"],
    ["push with one argument", "push⟦([1]);"],
    ["push with three arguments", "push⟦([1], 2, 3);"],
    ["push onto an integer", "push⟦(5, 1);"],
    ["push onto a string", 'push⟦("a", "b");'],
    ["push onto a record", "push⟦({}, 1);"],
    ["push onto nil", "push⟦(nil, 1);"],
    ["keys of an array", "keys⟦([1]);"],
    ["keys of nil", "keys⟦(nil);"],
    ["keys of a string", 'keys⟦("a");'],
    ["keys with two arguments", "keys⟦({}, 1);"],
    ["sleep with no arguments", "sleep⟦();"],
    ["sleep with a negative number", "sleep⟦(-1);"],
    ["sleep with a string", 'sleep⟦("5");'],
    ["sleep with a boolean", "sleep⟦(true);"],
    ["sleep with nil", "sleep⟦(nil);"],
    ["sleep with two arguments", "sleep⟦(1, 2);"],
    ["fetch with no arguments", "fetch⟦();"],
    ["fetch with an integer key", "fetch⟦(1);"],
    ["fetch with two arguments", 'fetch⟦("a", 1);'],
    ["fetch with nil", "fetch⟦(nil);"],
    ["builtin call on a later line", "let x = 1;\n\n  print(x);\n  len⟦(x);"],
  ];
  for (const [rule, template] of argumentErrors) {
    // Catches: builtin failures located at the argument or the name instead of the call's ( token, or accepted silently.
    test(`builtin argument error at the call's ( token: ${rule}`, async () => {
      const outcome = await expectRuntimeErrorAt(template);
      expect(outcome.sleepCalls).toEqual([]);
    });
  }

  // Catches: type check before the arity check when both fail, or errors inside arguments hidden by the arity error.
  test("builtin arguments are evaluated first; an error inside an argument wins over the arity check", async () => {
    await expectRuntimeErrorAt("len(⟦missing, 1);");
    await expectRuntimeErrorAt("print(1 ⟦/ 0, 2);");
    const outcome = await expectRuntimeErrorAt(SAY + 'len⟦(say("evaluated", 1), 2);');
    expect(outcome.output).toEqual(["evaluated"]);
  });

  // Catches: len of strings in code points; records/arrays confused.
  test("len: string length in UTF-16 code units, array element count, record field count", async () => {
    const source = 'print(len("")); print(len("héllo")); print(len("😀")); print(len("a\\nb")); print(len([])); print(len([1, [2, 3]])); print(len({})); print(len({a: 1, b: [1, 2]}));';
    expect((await expectOk(source)).output).toEqual(["0", "5", "2", "3", "0", "2", "0", "2"]);
  });

  // Catches: push returning the array/length, copying, or inserting at the wrong end.
  test("push appends in place and returns nil", async () => {
    const source = "let a = []; print(push(a, 1)); push(a, [2]); push(a, nil); print(a); print(len(a));";
    expect((await expectOk(source)).output).toEqual(["nil", "[1, [2], nil]", "3"]);
  });

  // Catches: keys returning values, a reference to internal storage, or sorted order.
  test("keys returns a new array of field names as strings in insertion order", async () => {
    const source = [
      'let r = {zeta: 1, alpha: 2, mid: 3}; let k = keys(r);',
      "print(k); print(keys({})); push(k, \"x\"); print(len(r)); print(keys(r));",
      'let t = {a: 1}; t.b = 2; t.a = 3; print(keys(t));',
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(['["zeta", "alpha", "mid"]', "[]", "3", '["zeta", "alpha", "mid"]', '["a", "b"]']);
  });

  // Catches: builtins treated as values that cannot be passed around.
  test("builtins are first-class values", async () => {
    const source = "let p = print; p(1); let fs = [len, keys]; print(fs[0]([1, 2])); fn apply(f, x) { return f(x); } print(apply(len, \"abc\"));";
    expect((await expectOk(source)).output).toEqual(["1", "2", "3"]);
  });
});

describe("sleep and fetch (7) and the clock (1)", () => {
  const io = {
    user: { value: { name: "ana", tags: ["a", "b"] }, latencyMs: 40 },
    count: { value: 5, latencyMs: 0 },
    nothing: { value: null, latencyMs: 3 },
    text: { value: "hello", latencyMs: 1 },
    flag: { value: true, latencyMs: 2 },
    list: { value: [1, [2, { deep: [3] }]], latencyMs: 10 },
  };

  // Catches: sleeping with real timers, skipping sleep(0), or passing the argument through wrongly.
  test("sleep(ms) awaits clock.sleep(ms) exactly once with that value; elapsed virtual time is ms", async () => {
    const outcome = await expectOk("sleep(250); sleep(0); print(1);");
    expect(outcome.sleepCalls.map((call) => call.ms)).toEqual([250, 0]);
    expect(outcome.elapsed).toBe(250);
    expect(outcome.output).toEqual(["1"]);
  });

  // Catches: sleeping in a Ripple program leaking a real wait (or never awaiting).
  test("sequential sleeps add up on the virtual clock and a huge sleep costs no real time", async () => {
    const started = Date.now();
    const outcome = await expectOk("sleep(1000000000); print(1); sleep(1000000000); print(2);");
    expect(outcome.elapsed).toBe(2000000000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // Catches: fetch converting values wrongly or ignoring the latency.
  test("fetch returns the Ripple value of io[key].value after clock.sleep(latencyMs)", async () => {
    const source = [
      'let user = fetch("user"); print(user.name); print(user.tags); print(user);',
      'print(fetch("count")); print(fetch("nothing")); print(fetch("text")); print(fetch("flag"));',
      'print(fetch("nothing") == nil); print(fetch("list"));',
    ].join("\n");
    const outcome = await expectOk(source, io);
    expect(outcome.output).toEqual([
      "ana",
      '["a", "b"]',
      '{name: "ana", tags: ["a", "b"]}',
      "5",
      "nil",
      "hello",
      "true",
      "true",
      "[1, [2, {deep: [3]}]]",
    ]);
    expect(outcome.sleepCalls.map((call) => call.ms)).toEqual([40, 0, 3, 1, 2, 3, 10]);
  });

  // Catches: fetch returning a shared reference into io, so a program's writes change the next fetch or the caller's table.
  test("fetch returns a deep copy: mutations never reach io or a later fetch", async () => {
    const source = [
      'let a = fetch("user"); a.name = "changed"; push(a.tags, "z"); a.extra = 1;',
      'let b = fetch("user"); print(b); print(a);',
      'let l = fetch("list"); l[1][1].deep[0] = 99; push(l, 4); print(fetch("list")); print(l);',
    ].join("\n");
    const outcome = await expectOk(source, io);
    expect(outcome.output).toEqual([
      '{name: "ana", tags: ["a", "b"]}',
      '{name: "changed", tags: ["a", "b", "z"], extra: 1}',
      "[1, [2, {deep: [3]}]]",
      "[1, [2, {deep: [99]}], 4]",
    ]);
    expect(io.user.value).toEqual({ name: "ana", tags: ["a", "b"] });
    expect(io.list.value).toEqual([1, [2, { deep: [3] }]]);
  });

  // Catches: io shared between runs, or a run keeping state from the previous run.
  test("two runs on the same io table see the same data (run never modifies options.io)", async () => {
    const program = 'let u = fetch("user"); u.tags[0] = "x"; print(u);';
    const first = await expectOk(program, io);
    const second = await expectOk(program, io);
    expect(first.output).toEqual(['{name: "ana", tags: ["x", "b"]}']);
    expect(second.output).toEqual(first.output);
  });

  // Catches: a missing key sleeping first, or `key in io` finding Object.prototype members.
  test("fetch of a key that is not an own property of io is a RuntimeError at the (, and no sleep happens", async () => {
    for (const key of ["missing", "toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"]) {
      const outcome = await expectRuntimeErrorAt(`print(1);\nfetch⟦("${key}");`, io);
      expect(outcome.sleepCalls).toEqual([]);
      expect(outcome.output).toEqual(["1"]);
    }
  });

  // Catches: io undefined crashing the runtime instead of a RuntimeError.
  test("fetch with no io option at all is a RuntimeError at the (", async () => {
    const outcome = await expectRuntimeErrorAt('fetch⟦("anything");');
    expect(outcome.sleepCalls).toEqual([]);
  });

  // Catches: an inherited-key check applied to a legitimately own property named like a prototype member.
  test("an own property of io named like an Object.prototype member is fetchable", async () => {
    const ownKeys = JSON.parse('{"constructor": {"value": 7, "latencyMs": 1}, "__proto__": {"value": {"__proto__": 1}, "latencyMs": 2}}');
    const outcome = await expectOk('print(fetch("constructor")); let r = fetch("__proto__"); print(r); print(keys(r));', ownKeys);
    expect(outcome.output).toEqual(["7", "{__proto__: 1}", '["__proto__"]']);
  });

  // Catches: fetch record fields reordered or sorted.
  test("fetched records keep their insertion order", async () => {
    const ordered = { rec: { value: { z: 1, a: 2, m: 3 }, latencyMs: 0 } };
    expect((await expectOk('print(fetch("rec")); print(keys(fetch("rec")));', ordered)).output).toEqual(["{z: 1, a: 2, m: 3}", '["z", "a", "m"]']);
  });

  // Catches: run swallowing a clock failure (the spec: it rejects only if clock.sleep itself rejects).
  test("run rejects when clock.sleep rejects, and only then", async () => {
    await expect(execWithRejectingClock("print(1); sleep(5); print(2);", new Error("clock broke"))).rejects.toThrow("clock broke");
    await expect(execWithRejectingClock('fetch("k");', new Error("clock broke"), { k: { value: 1, latencyMs: 4 } })).rejects.toThrow("clock broke");
    const fine = await execWithRejectingClock("print(1 / 0);", new Error("unused"));
    expect(fine.error).toMatchObject({ kind: "RuntimeError" });
    const syntax = await execWithRejectingClock("let = ;", new Error("unused"));
    expect(syntax.error).toMatchObject({ kind: "SyntaxError" });
  });

  // Catches: module-level state shared between runs (counters, scopes, output).
  test("runs are independent: results do not depend on earlier or concurrent runs", async () => {
    const program = "let cells = [0]; fn bump() { cells[0] = cells[0] + 1; return cells[0]; } bump(); print(bump()); sleep(10); print(len(cells));";
    const solo = await exec(program);
    const [left, right] = await Promise.all([exec(program), exec(program)]);
    for (const outcome of [left, right]) {
      expect(outcome.output).toEqual(["2", "1"]);
      expect(outcome.heap).toEqual(solo.heap);
      expect(outcome.elapsed).toBe(10);
    }
    const afterError = await exec("print(1 / 0);");
    const again = await exec(program);
    expect(afterError.error).not.toBeNull();
    expect(again).toEqual(solo);
  });
});

describe("runtime error positions across lines and widths (11)", () => {
  // Catches: line/column computed from the wrong token (end of expression, start of statement).
  test.each([
    ["operator on a later line than its left operand", "let a = 1;\nprint(a +\n  a ⟦/ 0);"],
    ["call on a later line", "fn f(a) { }\n\n\n  f⟦();"],
    ["index with a tab before it", "let a = [];\n\t\tprint(a⟦[0]);"],
    ["field after astral characters in a string", 'let s = "😀"; let r = {}; print(s + "😀", r⟦.x);'],
    ["CRLF line endings", "print(1);\r\nprint(2);\r\nprint(nil ⟦+ 1);"],
    ["column after a comment line", "// leading comment\nprint(1 ⟦/ 0);"],
  ])("position: %s", async (_label, template) => {
    await expectRuntimeErrorAt(template);
  });
});
