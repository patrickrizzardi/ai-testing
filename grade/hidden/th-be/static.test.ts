// Spec section 4: scopes, resolution, hoisting, initialization, static errors.
// Tier: High (validators, scoping rules).
import { describe, expect, test } from "bun:test";
import { exec, expectOk, expectRuntimeErrorAt, expectSyntaxErrorAt } from "./harness.ts";

describe("static errors (4.2): invalid assignment targets", () => {
  // Catches: invalid targets accepted (or reported at the target instead of the = token).
  const invalid: [string, string][] = [
    ["parenthesized name", "let a = 1; (a) ⟦= 2;"],
    ["call", "fn f(x) { return x; } f(1) ⟦= 2;"],
    ["binary expression", "let a = 1; a + 1 ⟦= 2;"],
    ["unary expression", "let a = 1; -a ⟦= 2;"],
    ["integer literal", "1 ⟦= 2;"],
    ["string literal", '"s" ⟦= 2;'],
    ["nil", "nil ⟦= 2;"],
    ["array literal", "[1] ⟦= 2;"],
    ["record literal", "{a: 1} ⟦= 2;"],
    ["call as the last suffix after a field", "let r = {f: 1}; r.f() ⟦= 2;"],
    ["call as the last suffix after an index", "let a = [1]; a[0]() ⟦= 2;"],
    ["parenthesized index expression", "let a = [1]; (a[0]) ⟦= 2;"],
    ["parenthesized field expression", "let r = {a: 1}; (r.a) ⟦= 2;"],
    ["comparison", "let a = 1; a == 1 ⟦= 2;"],
    ["spec example 1 + 2 = 3", "1 + 2 ⟦= 3;"],
  ];
  for (const [rule, template] of invalid) {
    test(`the left side of = is not a valid target: ${rule} (error at the = token)`, async () => {
      await expectSyntaxErrorAt(template);
    });
  }

  // Catches: valid targets rejected (each is a legal shape that fails only at run time).
  test("name, index, field, and call/paren-based index and field targets are valid", async () => {
    const source = [
      "fn pick(x) { return x; }",
      "let a = [0, 0, 0];",
      "let r = {f: 0, g: [0]};",
      "let n = 0;",
      "n = 1;",
      "a[0] = 2;",
      "r.f = 3;",
      "r.g[0] = 4;",
      "(a)[1] = 5;",
      "(r).f = 6;",
      "pick(a)[2] = 7;",
      "pick(r).g = 8;",
      "pick(r).h = 9;",
      "print(n); print(a); print(r);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["1", "[2, 5, 7]", "{f: 6, g: 8, h: 9}"]);
  });

  // Catches: only the first/last static error reported instead of the smallest position.
  test("with several static errors the smallest position (line, then column) is reported", async () => {
    await expectSyntaxErrorAt("let a = 1;\nlet ⟦a = 2;\n1 = 2;\nreturn 1;");
    await expectSyntaxErrorAt("let a = 1;\n1 ⟦= 2;\nlet a = 2;");
    await expectSyntaxErrorAt("⟦return 1;\nlet a = 1;\nlet a = 2;");
    await expectSyntaxErrorAt("let r = {a: 1, ⟦a: 2};\nreturn 1;");
    await expectSyntaxErrorAt("fn f() {}\nlet x = 1; ⟦f = 2; 1 = 2;");
    await expectSyntaxErrorAt("let q = 1; 1 ⟦= 2; let q = 3;");
  });
});

describe("static errors (4.2): duplicate declarations", () => {
  const duplicates: [string, string][] = [
    ["let / let (spec example)", "let a = 1;\nlet ⟦a = 2;"],
    ["let / fn", "let f = 1;\nfn ⟦f() { }"],
    ["fn / let", "fn f() { }\nlet ⟦f = 1;"],
    ["fn / fn", "fn f() { }\nfn ⟦f() { }"],
    ["fn declared after a let of the same name in a later position of the line", "let f = 1; fn ⟦f() { }"],
    ["two parameters", "fn f(a, ⟦a) { }"],
    ["parameter and a body let", "fn f(a) { let ⟦a = 1; }"],
    ["parameter and a body fn", "fn f(a) { fn ⟦a() { } }"],
    ["loop variable and a body let", "for i in [] { let ⟦i = 1; }"],
    ["loop variable and a body fn", "for i in [] { fn ⟦i() { } }"],
    ["in an if block", "if true { let a = 1; let ⟦a = 2; }"],
    ["in an else block", "if true { } else { let a = 1; fn ⟦a() { } }"],
    ["in an else-if block", "if true { } else if true { let a = 1; let ⟦a = 2; }"],
    ["in a while block", "while false { let a = 1; let ⟦a = 2; }"],
    ["in a nested function", "fn f() { fn g() { let a = 1; let ⟦a = 2; } }"],
    ["in a function body after nested statements", "fn f() { let a = 1; if true { } let ⟦a = 2; }"],
    ["builtin-named let twice", "let print = 1; let ⟦print = 2;"],
  ];
  for (const [rule, template] of duplicates) {
    // Catches: a duplicate in one scope accepted, or reported at the earlier declaration.
    test(`a name declared twice in one scope is an error at the later name token: ${rule}`, async () => {
      await expectSyntaxErrorAt(template);
    });
  }

  // Catches: shadowing across scopes wrongly reported as a duplicate.
  test("the same name in different scopes is fine: nested blocks, parameters, loop variables, builtins", async () => {
    const source = [
      "let a = 1;",
      "if true { let a = 2; print(a); }",
      "let n = 0;",
      "while n < 1 { let a = 3; print(a); n = n + 1; }",
      "fn f(a) { let b = a; if true { let a = b + 1; return a; } }",
      "for a in [5] { print(a); }",
      "let len = 4;",
      "print(f(10)); print(a); print(len);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["2", "3", "5", "11", "1", "4"]);
  });
});

describe("static errors (4.2): assignment to fn and builtin", () => {
  const targets: [string, string][] = [
    ["builtin print", "⟦print = 1;"],
    ["builtin len", "if true { ⟦len = 1; }"],
    ["builtin push inside a function", "fn f() { ⟦push = 1; }"],
    ["builtin keys, sleep, fetch", "⟦keys = 1;"],
    ["a fn declaration", "fn f() { }\n⟦f = 1;"],
    ["a fn declared later (hoisted)", "⟦f = 1;\nfn f() { }"],
    ["a fn from inside another function", "fn f() { }\nfn g() { ⟦f = 2; }"],
    ["a fn from a nested block", "fn f() { }\nwhile false { ⟦f = 2; }"],
    ["a fn assigned in its own body", "fn f() { ⟦f = 2; }"],
  ];
  for (const [rule, template] of targets) {
    // Catches: functions or builtins assignable like variables.
    test(`a bare identifier target that resolves to a fn or builtin is an error at the identifier: ${rule}`, async () => {
      await expectSyntaxErrorAt(template);
    });
  }

  // Catches: the check done by name instead of by resolution.
  test("a variable that shadows a fn or builtin is assignable", async () => {
    const source = [
      "fn f() { }",
      "if true { let f = 1; f = 2; print(f); }",
      "fn g(print) { print = 5; return print; }",
      "let len = 1;",
      "len = 3;",
      "print(g(0)); print(len);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["2", "5", "3"]);
  });

  // Catches: index/field assignment through a fn/builtin name treated as a bare-identifier assignment.
  test("an index or field assignment is not a bare-identifier assignment: no static error, a run-time error at [ or .", async () => {
    await expectRuntimeErrorAt("fn f() { }\nf⟦[0] = 1;");
    await expectRuntimeErrorAt("print⟦.x = 1;");
  });
});

describe("static errors (4.2): return and record fields", () => {
  const returns: [string, string][] = [
    ["at the top level", "⟦return 1;"],
    ["a bare return at the top level", "⟦return;"],
    ["in a top-level if block", "if true { ⟦return; }"],
    ["in a top-level while block", "while false { ⟦return 1; }"],
    ["in a top-level for block", "for x in [] { ⟦return 1; }"],
    ["after valid statements", "print(1);\nlet a = 2;\n  ⟦return a;"],
  ];
  for (const [rule, template] of returns) {
    // Catches: return allowed in the program scope or blocks outside any function.
    test(`return outside any function body is an error at the return token: ${rule}`, async () => {
      await expectSyntaxErrorAt(template);
    });
  }

  // Catches: return rejected in nested constructs of a function.
  test("return is valid anywhere inside a function body, including nested blocks and loops", async () => {
    const source = [
      "fn find(items, wanted) { for item in items { if item == wanted { return true; } } return false; }",
      "fn first() { while true { if true { return 1; } } }",
      "fn early(n) { if n > 0 { return n; } else { return 0 - n; } }",
      "print(find([1, 2], 2)); print(find([1], 3)); print(first()); print(early(3)); print(early(-4));",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["true", "false", "1", "3", "4"]);
  });

  const duplicateFields: [string, string][] = [
    ["two fields", "let r = {a: 1, b: 2, ⟦a: 3};"],
    ["the later of three equal names", "let r = {a: 1, ⟦a: 2, a: 3};"],
    ["nested literal", "let r = {x: {k: 1, ⟦k: 2}};"],
    ["inside a function", "fn f() { return {p: 1, q: 2, ⟦p: 3}; }"],
    ["inside a call argument", "print({a: 1, ⟦a: 2});"],
  ];
  for (const [rule, template] of duplicateFields) {
    // Catches: duplicate record fields accepted (last wins) or reported at the earlier name.
    test(`a record literal that repeats a field name is an error at the later name: ${rule}`, async () => {
      await expectSyntaxErrorAt(template);
    });
  }

  // Catches: duplicate detection across nested/sibling literals.
  test("the same field name in different record literals, or nested ones, is fine", async () => {
    expect((await expectOk("let r = {a: {a: 1}, b: {a: 2}}; print(r);")).output).toEqual(["{a: {a: 1}, b: {a: 2}}"]);
  });
});

describe("scopes and resolution (4.1)", () => {
  // Catches: functions bound at their statement instead of at scope entry.
  test("fn declarations are hoisted: callable before their statement, in every kind of scope", async () => {
    const source = [
      "print(top());",
      "fn top() { return inner(); fn inner() { return \"in\"; } }",
      "if true { print(blockFn()); fn blockFn() { return \"b\"; } }",
      "fn mutualA(n) { if n == 0 { return \"a\"; } return mutualB(n - 1); }",
      "fn mutualB(n) { if n == 0 { return \"b\"; } return mutualA(n - 1); }",
      "print(mutualA(3));",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["in", "b", "b"]);
  });

  // Catches: hoisted closures capturing a copy of the scope at the wrong time.
  test("a hoisted closure sees variables declared after it, once they are initialized", async () => {
    const source = "fn show() { return later; }\nlet later = 5;\nprint(show());";
    expect((await expectOk(source)).output).toEqual(["5"]);
  });

  // Catches: early read returning nil/undefined instead of a RuntimeError at the identifier.
  test("reading a let before its statement ran is a RuntimeError at the identifier", async () => {
    await expectRuntimeErrorAt("print(1);\nprint(⟦x);\nlet x = 1;");
  });

  // Catches: early read inside a function located at the call or at the declaration.
  test("an early read through a closure is located at the identifier in the function's source", async () => {
    const outcome = await expectRuntimeErrorAt("fn show() { return ⟦later; }\nprint(show());\nlet later = 5;");
    expect(outcome.output).toEqual([]);
  });

  // Catches: an uninitialized read in a let initializer falling back to an outer variable.
  test("let x = x: the initializer sees the new, uninitialized x, not the outer one", async () => {
    await expectRuntimeErrorAt("let x = ⟦x;");
    await expectRuntimeErrorAt("let x = 1;\nif true { let x = ⟦x + 1; }");
  });

  // Catches: the declaration made visible only after its statement (flow-sensitive scoping).
  test("a name declared later in the same scope shadows an outer one from the start of the scope", async () => {
    await expectRuntimeErrorAt("let x = 1;\nif true { print(⟦x); let x = 2; }");
    await expectRuntimeErrorAt("let x = 1;\nfn f() { print(⟦x); let x = 2; }\nf();");
  });

  // Catches: an assignment to an uninitialized binding silently initializing it.
  test("assigning to a let before its statement is a RuntimeError at the identifier", async () => {
    await expectRuntimeErrorAt("⟦x = 1;\nlet x = 0;");
  });

  // Catches: an unresolved name reading nil, or reported as a static error.
  test("an unresolved name is a RuntimeError when evaluated (not a static error), at the identifier", async () => {
    const outcome = await expectRuntimeErrorAt("print(1);\nprint(⟦missing);");
    expect(outcome.output).toEqual(["1"]);
    await expectRuntimeErrorAt("⟦missing = 1;");
    await expectRuntimeErrorAt("⟦missing();");
  });

  // Catches: an unresolved name inside code that never runs reported anyway.
  test("an unresolved name in code that does not run is not an error", async () => {
    expect((await expectOk('fn never() { return missing; }\nif false { print(missing); }\nprint("ok");')).output).toEqual(["ok"]);
  });

  // Catches: JS prototype names (toString, constructor, __proto__) resolving to something.
  test.each(["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "prototype"])(
    "the name %s is unresolved unless declared",
    async (name) => {
      await expectRuntimeErrorAt(`print(⟦${name});`);
      expect((await expectOk(`let ${name} = 3; print(${name});`)).output).toEqual(["3"]);
    },
  );

  // Catches: loop bodies sharing one scope across iterations (state leaking between iterations).
  test("every iteration of a while body is a fresh scope: a let is uninitialized again", async () => {
    const source = "let c = 0;\nwhile c < 2 {\n  if c == 1 { print(⟦z); }\n  let z = c;\n  c = c + 1;\n}";
    await expectRuntimeErrorAt(source);
  });

  // Catches: closures capturing one shared loop variable.
  test("each for iteration has its own loop variable: closures capture per-iteration values", async () => {
    const source = [
      "let getters = [];",
      "for i in [1, 2, 3] { fn get() { return i; } push(getters, get); }",
      "print(getters[0]()); print(getters[1]()); print(getters[2]());",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["1", "2", "3"]);
  });

  // Catches: closures in a while body capturing the enclosing scope instead of the iteration scope.
  test("each while iteration has its own scope: closures capture per-iteration lets", async () => {
    const source = [
      "let getters = [];",
      "let n = 0;",
      "while n < 3 { let k = n * 10; fn get() { return k; } push(getters, get); n = n + 1; }",
      "print(getters[0]()); print(getters[1]()); print(getters[2]());",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["0", "10", "20"]);
  });

  // Catches: the loop variable visible in the iterable expression.
  test("the for iterable is resolved outside the loop variable: for x in x uses the outer x", async () => {
    expect((await expectOk("let x = [1, 2]; for x in x { print(x); }")).output).toEqual(["1", "2"]);
    await expectRuntimeErrorAt("for x in ⟦x { }");
  });

  // Catches: assignment to the loop variable writing through to the array, or being rejected.
  test("the loop variable is an assignable variable that does not change the array", async () => {
    const source = "let a = [1, 2]; for x in a { x = x + 10; print(x); } print(a);";
    expect((await expectOk(source)).output).toEqual(["11", "12", "[1, 2]"]);
  });

  // Catches: a let in an inner scope assigning the outer variable.
  test("a let of an outer name declares a new shadowing variable; assignment without let changes the outer one", async () => {
    const source = [
      "let x = 1;",
      "if true { let x = 2; x = 3; }",
      "print(x);",
      "if true { x = 4; }",
      "print(x);",
      "fn f() { let x = 5; return x; }",
      "print(f()); print(x);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["1", "4", "5", "4"]);
  });

  // Catches: closures capturing values instead of the scope (variables).
  test("a closure sees later assignments to the variables it captured", async () => {
    const source = "let x = 1; fn read() { return x; } x = 2; print(read()); x = 3; print(read());";
    expect((await expectOk(source)).output).toEqual(["2", "3"]);
  });

  // Catches: parameters resolved dynamically (caller's scope) instead of lexically.
  test("resolution is lexical, not dynamic: a callee does not see its caller's variables", async () => {
    const source = "fn peek() { return ⟦secret; }\nfn caller() { let secret = 1; return peek(); }\nprint(caller());";
    await expectRuntimeErrorAt(source);
  });

  // Catches: parameter/body names living in different scopes (so a body let could shadow without error).
  test("a closure captures the parameters of the call that created it", async () => {
    const source = "fn make(n) { fn get() { return n; } return get; }\nlet g = make(7);\nprint(g());";
    expect((await expectOk(source)).output).toEqual(["7"]);
  });

  // Catches: a re-declared fn in a loop body binding once per run instead of once per iteration.
  test("each execution of a scope creates new closures for its fn declarations", async () => {
    const source = [
      "fn maker() { fn inner() { return 1; } return inner; }",
      "let first = maker(); let second = maker();",
      "print(first == first); print(first == second);",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["true", "false"]);
  });
});

describe("static analysis is independent of execution", () => {
  // Catches: static checks done lazily (when the statement runs) so output appears before the error.
  test("a static error stops the program before anything runs", async () => {
    const outcome = await exec("print(1);\nsleep(5);\nlet a = 1;\nlet a = 2;");
    expect(outcome.output).toEqual([]);
    expect(outcome.sleepCalls).toEqual([]);
    expect(outcome.error).toMatchObject({ kind: "SyntaxError", line: 4, column: 5 });
  });

  // Catches: static checks skipped inside functions that are never called.
  test("static errors inside never-called functions and dead branches are still reported", async () => {
    await expectSyntaxErrorAt("fn never() { let a = 1; let ⟦a = 2; }");
    await expectSyntaxErrorAt("if false { ⟦print = 1; }");
    await expectSyntaxErrorAt("fn never() { 1 ⟦= 2; }");
  });
});
