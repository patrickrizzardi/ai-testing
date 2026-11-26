// Spec sections 5 and 6.1: values, display, equality, operators. Tier: High
// (pure math, validators, the value model): the edge cases are the contract.
import { describe, expect, test } from "bun:test";
import { expectOk, expectRuntimeErrorAt } from "./harness.ts";

async function value(expression: string, prelude = ""): Promise<string> {
  const outcome = await expectOk(`${prelude}print(${expression});`);
  expect(outcome.output).toHaveLength(1);
  return outcome.output[0] as string;
}

const MAX = "9007199254740991";

describe("integer division and modulo (6.1)", () => {
  const division: [string, string][] = [
    ["7 / 2", "3"],
    ["-7 / 2", "-3"],
    ["7 / -2", "-3"],
    ["-7 / -2", "3"],
    ["1 / 2", "0"],
    ["-1 / 2", "0"],
    ["0 / 5", "0"],
    ["0 / -5", "0"],
    ["6 / 3", "2"],
    ["-6 / 3", "-2"],
    [`${MAX} / 2`, "4503599627370495"],
    [`-${MAX} / 2`, "-4503599627370495"],
    ["9007199254740990 / 3", "3002399751580330"],
    [`${MAX} / ${MAX}`, "1"],
    [`${MAX} / -1`, `-${MAX}`],
    [`-${MAX} / -1`, MAX],
    [`${MAX} / 1000000007`, "9007199"],
  ];
  for (const [expression, expected] of division) {
    // Catches: floor division, rounding, or 32-bit truncation instead of truncation toward zero on safe integers.
    test(`division truncates toward zero: ${expression} is ${expected}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }

  const modulo: [string, string][] = [
    ["7 % 3", "1"],
    ["-7 % 3", "-1"],
    ["7 % -3", "1"],
    ["-7 % -3", "-1"],
    ["7 % -2", "1"],
    ["0 % 5", "0"],
    ["5 % 5", "0"],
    ["-6 % 3", "0"],
    ["3 % 7", "3"],
    ["-3 % 7", "-3"],
    [`${MAX} % 10`, "1"],
    [`-${MAX} % 2`, "-1"],
    [`${MAX} % 9007199254740990`, "1"],
    ["2 % 1", "0"],
  ];
  for (const [expression, expected] of modulo) {
    // Catches: floored modulo (sign of the divisor) instead of a - (a / b) * b.
    test(`modulo takes the sign of the dividend: ${expression} is ${expected}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }

  // Catches: JS -0 leaking into the output as "-0".
  test("there is one zero: results that are mathematically zero print as 0", async () => {
    const outcome = await expectOk("print(0 * -1); print(-0); print(0 - 0); print(-1 / 2); print(-6 % 3); print(0 / -5); print(-0 == 0);");
    expect(outcome.output).toEqual(["0", "0", "0", "0", "0", "0", "true"]);
  });

  const byZero: [string, string][] = [
    ["division", "print(1 ⟦/ 0);"],
    ["modulo", "print(1 ⟦% 0);"],
    ["zero divided by zero", "print(0 ⟦/ 0);"],
    ["zero modulo zero", "print(0 ⟦% 0);"],
    ["negative dividend", "print(-5 ⟦/ 0);"],
    ["zero computed", "let z = 1 - 1; print(7 ⟦% z);"],
    ["unary-minus zero", "print(7 ⟦/ -0);"],
  ];
  for (const [rule, template] of byZero) {
    // Catches: division by zero yielding Infinity/NaN/0 or reported at the operand.
    test(`division or modulo by zero is a RuntimeError at the operator: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }
});

describe("integer overflow (5): results outside ±9007199254740991 are RuntimeErrors", () => {
  const inRange: [string, string][] = [
    [`${MAX} + 0`, MAX],
    ["9007199254740990 + 1", MAX],
    [`-9007199254740990 - 1`, `-${MAX}`],
    [`${MAX} - ${MAX}`, "0"],
    [`${MAX} + -${MAX}`, "0"],
    [`${MAX} * 1`, MAX],
    [`${MAX} * -1`, `-${MAX}`],
    [`${MAX} * 0`, "0"],
    ["94906265 * 94906265", "9007199136250225"],
    ["3002399751580330 * 3", "9007199254740990"],
    [`-${MAX}`, `-${MAX}`],
    [`- -${MAX}`, MAX],
  ];
  for (const [expression, expected] of inRange) {
    // Catches: overflow check off by one at the boundary (rejecting the limit itself).
    test(`at the boundary, still valid: ${expression}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }

  const overflow: [string, string][] = [
    ["max + 1", `print(${MAX} ⟦+ 1);`],
    ["1 + max", `print(1 ⟦+ ${MAX});`],
    ["min - 1", `print(-${MAX} ⟦- 1);`],
    ["max - -1", `print(${MAX} ⟦- -1);`],
    ["-max + -1", `print(-${MAX} ⟦+ -1);`],
    ["max * 2", `print(${MAX} ⟦* 2);`],
    ["max * -2", `print(${MAX} ⟦* -2);`],
    ["max * max", `print(${MAX} ⟦* ${MAX});`],
    ["94906266 * 94906266 (just over)", "print(94906266 ⟦* 94906266);"],
    ["3 * 3002399751580331 (exact result 2^53 + 1, not representable)", "print(3 ⟦* 3002399751580331);"],
    ["4503599627370496 * 2 (exactly 2^53)", "print(4503599627370496 ⟦* 2);"],
    ["3037000499 squared (exceeds 2^63 style 64-bit checks)", "print(3037000499 ⟦* 3037000499);"],
    ["the failing step is the first one: max + 1 - 1", `print(${MAX} ⟦+ 1 - 1);`],
    ["overflow inside a larger expression", `let big = ${MAX}; print(1 + (big ⟦+ 1));`],
  ];
  for (const [rule, template] of overflow) {
    // Catches: no range check, or a float-rounded result mistaken for in-range.
    test(`out-of-range result is a RuntimeError at the operator: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  // Catches: repeated arithmetic drifting past the limit unnoticed (checking only the final value).
  test("a loop that doubles runs until overflow and stops there with the output so far", async () => {
    const outcome = await expectRuntimeErrorAt("let n = 1;\nwhile true {\n  print(n);\n  n = n ⟦* 2;\n}");
    expect(outcome.output).toHaveLength(53);
    expect(outcome.output[52]).toBe("4503599627370496");
  });
});

describe("operand and type rules (6.1)", () => {
  const typeErrors: [string, string][] = [
    ["int + string", 'print(1 ⟦+ "a");'],
    ["string + int", 'print("a" ⟦+ 1);'],
    ["nil + nil", "print(nil ⟦+ nil);"],
    ["bool + bool", "print(true ⟦+ true);"],
    ["array + array", "print([1] ⟦+ [2]);"],
    ["record + record", "print({} ⟦+ {});"],
    ["string - string", 'print("a" ⟦- "b");'],
    ["string * int", 'print("a" ⟦* 2);'],
    ["int * string", 'print(2 ⟦* "a");'],
    ["string / int", 'print("a" ⟦/ 1);'],
    ["int / string", 'print(1 ⟦/ "a");'],
    ["string % int", 'print("a" ⟦% 1);'],
    ["bool - int", "print(true ⟦- 1);"],
    ["nil * int", "print(nil ⟦* 1);"],
    ["bool < bool", "print(true ⟦< false);"],
    ["nil < nil", "print(nil ⟦< nil);"],
    ["int < string", 'print(1 ⟦< "a");'],
    ["string < int", 'print("a" ⟦< 1);'],
    ["array < array", "print([1] ⟦< [2]);"],
    ["int <= nil", "print(1 ⟦<= nil);"],
    ["string > bool", 'print("a" ⟦> true);'],
    ["int >= bool", "print(1 ⟦>= true);"],
    ["record <= record", "print({} ⟦<= {});"],
    ["- string", 'print(⟦-"a");'],
    ["- bool", "print(⟦-true);"],
    ["- nil", "print(⟦-nil);"],
    ["- array", "print(⟦-[1]);"],
    ["! int", "print(⟦!1);"],
    ["! nil", "print(⟦!nil);"],
    ["! string", 'print(⟦!"a");'],
    ["! array", "print(⟦![]);"],
    ["int && bool", "print(1 ⟦&& true);"],
    ["nil && bool", "print(nil ⟦&& true);"],
    ["string || bool", 'print("a" ⟦|| true);'],
    ["true && int", "print(true ⟦&& 1);"],
    ["true && nil", "print(true ⟦&& nil);"],
    ["false || int", "print(false ⟦|| 1);"],
    ["false || string", 'print(false ⟦|| "x");'],
    ["chained: true && true && int", "print(true && true ⟦&& 5);"],
  ];
  for (const [rule, template] of typeErrors) {
    // Catches: JS coercion (1 + "a" = "1a", true + 1, nil < 1, ![]...) instead of a RuntimeError at the operator token.
    test(`type error at the operator token: ${rule}`, async () => {
      await expectRuntimeErrorAt(template);
    });
  }

  // Catches: && / || always evaluating b, or checking its type when it was skipped.
  test("&& and || short-circuit: b is neither evaluated nor type-checked when a decides", async () => {
    const prelude = 'fn noisy(label) { print(label); return true; }\n';
    const outcome = await expectOk(
      prelude +
        [
          "print(false && noisy(\"and-skipped\"));",
          "print(true || noisy(\"or-skipped\"));",
          "print(false && 1);",
          "print(true || 1);",
          "print(false && missing);",
          "print(true || (1 / 0 == 0));",
          "print(true && noisy(\"and-run\"));",
          "print(false || noisy(\"or-run\"));",
        ].join("\n"),
    );
    expect(outcome.output).toEqual(["false", "true", "false", "true", "false", "true", "and-run", "true", "or-run", "true"]);
  });

  // Catches: the result being the Ripple "truthiness" of a rather than b (spec: the result is b).
  test("a && b and a || b yield booleans: the result is b once a did not decide", async () => {
    expect(await value("true && false")).toBe("false");
    expect(await value("false || false")).toBe("false");
    expect(await value("true && true && true")).toBe("true");
    expect(await value("false || false || true")).toBe("true");
  });

  // Catches: the type check of a skipped in && (checking only b).
  test("a non-boolean a fails even when b is fine, at the operator; b is not evaluated", async () => {
    const outcome = await expectRuntimeErrorAt('fn noisy() { print("b"); return true; }\nprint(1 ⟦&& noisy());');
    expect(outcome.output).toEqual([]);
  });

  // Catches: a late type check that lets b's own error win over a's.
  test("&& with non-boolean a does not evaluate b: b's error never happens", async () => {
    await expectRuntimeErrorAt("print(nil ⟦&& (1 / 0 == 1));");
    await expectRuntimeErrorAt("print(nil ⟦|| missing);");
  });

  // Catches: operand evaluation skipped or reordered when the operator would fail.
  test("every operand is evaluated, left to right, before the operator's checks", async () => {
    const prelude = 'fn say(label, v) { print(label); return v; }\n';
    const outcome = await expectRuntimeErrorAt(prelude + 'print(say("l", "a") ⟦- say("r", 1));');
    expect(outcome.output).toEqual(["l", "r"]);
    const unary = await expectRuntimeErrorAt(prelude + 'print(⟦!say("operand", 5));');
    expect(unary.output).toEqual(["operand"]);
  });

  // Catches: the operator error reported instead of an error raised while evaluating an operand.
  test("an error inside an operand is reported at that operand, not at the operator", async () => {
    await expectRuntimeErrorAt('print("a" - ⟦missing);');
    await expectRuntimeErrorAt("print(1 + (1 ⟦/ 0));");
    await expectRuntimeErrorAt("print([1]⟦[5] + true);");
    await expectRuntimeErrorAt("print(⟦missing1 + missing2);");
    await expectRuntimeErrorAt("print(1 + 1 + ⟦missing);");
  });
});

describe("string operations", () => {
  // Catches: + on strings coercing, or comparing numerically.
  test("string + string concatenates; the empty string is the identity", async () => {
    expect(await value('"foo" + "bar"')).toBe("foobar");
    expect(await value('"" + "x" + ""')).toBe("x");
    expect(await value('"a\\n" + "b"')).toBe("a\nb");
  });

  const orderings: [string, string][] = [
    ['"a" < "b"', "true"],
    ['"b" < "a"', "false"],
    ['"a" < "ab"', "true"],
    ['"ab" < "a"', "false"],
    ['"" < "a"', "true"],
    ['"" < ""', "false"],
    ['"" <= ""', "true"],
    ['"a" <= "a"', "true"],
    ['"a" >= "a"', "true"],
    ['"B" < "a"', "true"],
    ['"a" < "B"', "false"],
    ['"Z" > "A"', "true"],
    ['"10" < "9"', "true"],
    ['"9" < "10"', "false"],
    ['"é" > "z"', "true"],
    ['"abc" > "abd"', "false"],
    ['"abc" >= "ab"', "true"],
    ['"a" > ""', "true"],
    // 😀 is the code units D83D DE00; ～ is FF5E. By UTF-16 code units 😀 sorts first; by code points it sorts last.
    ['"😀" < "～"', "true"],
    ['"😀" > "～"', "false"],
    ['"😀" > "\u{FFFF}"', "false"],
    ['"😀a" < "😀b"', "true"],
  ];
  for (const [expression, expected] of orderings) {
    // Catches: locale/code-point comparison, or prefix ordering reversed.
    test(`string order is by UTF-16 code units, shorter prefix first: ${expression} is ${expected}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }
});

describe("equality (5.2)", () => {
  const equalities: [string, string][] = [
    ["1 == 1", "true"],
    ["1 == 2", "false"],
    ['"a" == "a"', "true"],
    ['"a" == "A"', "false"],
    ['"" == ""', "true"],
    ["true == true", "true"],
    ["true == false", "false"],
    ["nil == nil", "true"],
    ["[] == []", "true"],
    ["[1, 2] == [1, 2]", "true"],
    ["[1, 2] == [2, 1]", "false"],
    ["[1] == [1, 2]", "false"],
    ["[[1], [2, [3]]] == [[1], [2, [3]]]", "true"],
    ["[[1], [2, [3]]] == [[1], [2, [4]]]", "false"],
    ["[nil] == [nil]", "true"],
    ["[nil] == []", "false"],
    ["{} == {}", "true"],
    ["{a: 1, b: 2} == {b: 2, a: 1}", "true"],
    ["{a: 1} == {a: 2}", "false"],
    ["{a: 1} == {a: 1, b: 2}", "false"],
    ["{a: 1, b: 2} == {a: 1, c: 2}", "false"],
    ["{a: [1, {b: 2}]} == {a: [1, {b: 2}]}", "true"],
    ["{a: nil} == {b: nil}", "false"],
    ["1 == true", "false"],
    ["0 == false", "false"],
    ['1 == "1"', "false"],
    ["0 == nil", "false"],
    ['"" == nil', "false"],
    ["nil == false", "false"],
    ["[] == {}", "false"],
    ["[] == nil", "false"],
    ["{} == nil", "false"],
    ["[] == false", "false"],
    ['[1] == "1"', "false"],
    ["print == print", "true"],
    ["print == len", "false"],
    ["print == nil", "false"],
    ["1 != 1", "false"],
    ["1 != 2", "true"],
    ["[1] != [1]", "false"],
    ["[1] != [2]", "true"],
    ['1 != "1"', "true"],
    ["{a: 1} != {a: 1}", "false"],
    ["nil != nil", "false"],
    ["nil != false", "true"],
  ];
  for (const [expression, expected] of equalities) {
    // Catches: reference equality for arrays/records, JS loose equality, or order-sensitive record comparison.
    test(`equality rule: ${expression} is ${expected}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }

  // Catches: function equality by name/declaration text instead of closure identity.
  test("closures are equal only if they are the same closure of the same execution", async () => {
    const source = [
      "fn a() { }",
      "fn b() { }",
      "fn maker() { fn inner() { } return inner; }",
      "let m1 = maker(); let m2 = maker(); let alias = m1;",
      "print(a == a); print(a == b); print(m1 == m2); print(m1 == alias); print(m1 != m2); print(a == 1); print(a == print); print([a] == [a]); print({f: a} == {f: b});",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["true", "false", "false", "true", "true", "false", "false", "true", "false"]);
  });

  // Catches: equality raising on functions or cross-type values.
  test("comparing different types is never an error", async () => {
    expect((await expectOk('print(1 == nil); print("a" != 1); print([] == print); print(nil != [nil]);')).output).toEqual([
      "false",
      "true",
      "false",
      "true",
    ]);
  });

  // Catches: equality mutating or caching by identity (aliasing).
  test("equal arrays stay equal as values: an alias and a copy compare the same, until one is modified", async () => {
    const source = "let a = [1]; let b = a; let c = [1]; print(a == b); print(a == c); push(b, 2); print(a == c); print(a == b);";
    expect((await expectOk(source)).output).toEqual(["true", "true", "false", "true"]);
  });
});

describe("display (5.1)", () => {
  const displays: [string, string, string][] = [
    ["integer", "7", "7"],
    ["negative integer", "-7", "-7"],
    ["zero", "0", "0"],
    ["leading zeros are not shown", "007", "7"],
    ["max integer", MAX, MAX],
    ["true", "true", "true"],
    ["false", "false", "false"],
    ["nil", "nil", "nil"],
    ["top-level string is its characters", '"a b"', "a b"],
    ["top-level string with a quote", '"say \\"hi\\""', 'say "hi"'],
    ["top-level string with a backslash", '"a\\\\b"', "a\\b"],
    ["top-level string with a newline is not escaped", '"a\\nb"', "a\nb"],
    ["top-level empty string", '""', ""],
    ["empty array", "[]", "[]"],
    ["empty record", "{}", "{}"],
    ["array of integers", "[1, 2, 3]", "[1, 2, 3]"],
    ["array of strings are quoted", '["a", "b"]', '["a", "b"]'],
    ["quote escaped in a nested string", '["a\\"b"]', '["a\\"b"]'],
    ["backslash escaped in a nested string", '["a\\\\b"]', '["a\\\\b"]'],
    ["LF escaped in a nested string", '["a\\nb"]', '["a\\nb"]'],
    ["tab escaped in a nested string", '["a\\tb"]', '["a\\tb"]'],
    ["CR escaped in a nested string", '["a\\rb"]', '["a\\rb"]'],
    ["all five in one nested string", '["\\n\\t\\r\\"\\\\"]', '["\\n\\t\\r\\"\\\\"]'],
    ["non-ASCII is not escaped in a nested string", '["é😀"]', '["é😀"]'],
    ["nested arrays", "[[1], [], [[2]]]", "[[1], [], [[2]]]"],
    ["mixed array (spec example)", '[1, "a\\"b", true, nil, [2], {k: 3}]', '[1, "a\\"b", true, nil, [2], {k: 3}]'],
    ["record", "{a: 1, b: 2}", "{a: 1, b: 2}"],
    ["record in insertion order, not sorted", "{b: 2, a: 1}", "{b: 2, a: 1}"],
    ["record with string and nested values", '{s: "x", n: nil, l: [1], r: {}}', '{s: "x", n: nil, l: [1], r: {}}'],
    ["record inside array", "[{a: 1}, {}]", "[{a: 1}, {}]"],
    ["negative numbers in arrays", "[-1, -2]", "[-1, -2]"],
    ["a string key-like text stays quoted", '{k: "a: b, c"}', '{k: "a: b, c"}'],
    ["builtin", "print", "<builtin print>"],
    ["another builtin", "fetch", "<builtin fetch>"],
    ["builtins inside an array", "[len, keys]", "[<builtin len>, <builtin keys>]"],
  ];
  for (const [rule, expression, expected] of displays) {
    // Catches: JSON/JS formatting instead of the spec's display rules.
    test(`display: ${rule}`, async () => {
      expect(await value(expression)).toBe(expected);
    });
  }

  // Catches: closures displayed by something other than their declared name, or nested closures failing.
  test("display of closures: <fn NAME>, also inside containers", async () => {
    const source = [
      "fn helper() { }",
      "fn maker() { fn inner() { } return inner; }",
      "print(helper); print(maker()); print([helper, maker]); print({f: helper});",
    ].join("\n");
    expect((await expectOk(source)).output).toEqual(["<fn helper>", "<fn inner>", "[<fn helper>, <fn maker>]", "{f: <fn helper>}"]);
  });

  // Catches: print returning something printable other than nil; each print adding separators.
  test("print returns nil and appends exactly display(v): no separators or newlines", async () => {
    const outcome = await expectOk('print(print(1)); print("a\\n"); print(""); print("b");');
    expect(outcome.output).toEqual(["1", "nil", "a\n", "", "b"]);
  });

  // Catches: strings in records displayed unquoted at the top of a nested value only.
  test("a string inside a record inside an array is quoted; a bare top-level string is not", async () => {
    expect((await expectOk('let r = {s: "t"}; print(r.s); print(r); print([r.s]);')).output).toEqual(["t", '{s: "t"}', '["t"]']);
  });
});
