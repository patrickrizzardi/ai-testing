# Ripple

Ripple is a small imperative language with first-class closures, automatic concurrency of independent asynchronous calls, and a counted heap. This document is the complete definition of the language and of the `run` function that executes it. Where this document gives a rule, the rule is exact; every situation is defined by it.

## 1. The `run` function

```ts
export type ValueRecord = { [field: string]: Value };
export type Value = null | boolean | number | string | Value[] | ValueRecord;

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type RunOptions = {
  clock: Clock;
  io?: Record<string, { value: Value; latencyMs: number }>;
};

export type RunResult = {
  output: string[];
  error: null | {
    kind: "SyntaxError" | "RuntimeError";
    message: string;
    line: number;
    column: number;
  };
  heap: { allocs: number; frees: number };
};

export function run(source: string, options: RunOptions): Promise<RunResult>;
```

- `run` parses and executes one Ripple program. The promise resolves with a `RunResult` for every program, including programs that fail; it rejects only if `clock.sleep` itself rejects.
- `output` has one string per executed `print` call, in the order given by section 9. No separators or newlines are added.
- `error` is `null` when the program finishes. Otherwise it describes the single error that stopped the program. `message` is a non-empty string whose wording is not specified. `line` and `column` are 1-based and locate the error as defined in section 11.
- A `SyntaxError` (any error of sections 2, 3 and 4) is found before anything executes: `output` is `[]` and `heap` is `{ allocs: 0, frees: 0 }`.
- A `RuntimeError` stops the program at once. `output` keeps everything printed before it (with the exception in section 9.4), and `heap` counts everything done up to it (section 10).
- The runtime reads time only through `options.clock`. `Clock.sleep(ms)` is the only way the runtime waits; it must not use any other timer or time source.
- Several calls to `run` are independent. `run` never modifies `options.io`.
- JS shape of Ripple values (`Value`): integer ↔ `number` (a safe integer, one zero), string ↔ `string`, boolean ↔ `boolean`, `nil` ↔ `null`, array ↔ `Value[]`, record ↔ plain object whose own keys are the field names in insertion order. Functions have no `Value` form. Every `Value` in `options.io` is a valid one: numbers are safe integers, record keys are identifiers (section 2) that are not keywords, and `latencyMs` is a non-negative integer.

## 2. Lexical structure

The source is a string of UTF-16 code units. A **column** counts code units; a **line** starts after each LF (`\n`) character. The first character is line 1, column 1. A tab counts as one column. CR is whitespace and does not start a line.

Whitespace is space, tab, CR and LF. A comment starts with `//` and runs up to (not including) the next LF or the end of the source. Whitespace and comments separate tokens and are otherwise ignored. Any other character outside a string literal that does not start a token is a lexical error.

Tokens are read left to right; at each position the longest token that fits is taken.

```ebnf
IDENT      = letter { letter | digit | "_" } ;       (* not a keyword *)
           ;  letter = "A".."Z" | "a".."z" | "_" ;  digit = "0".."9" ;
KEYWORD    = "let" | "if" | "else" | "while" | "for" | "in" | "fn"
           | "return" | "wait" | "true" | "false" | "nil" ;
INT        = digit { digit } ;
STRING     = '"' { stringChar | escape } '"' ;
stringChar = any code unit except '"', "\", LF ;
escape     = "\n" | "\t" | "\r" | '\"' | "\\" ;       (* backslash followed by n, t, r, ", \ *)
PUNCT      = "||" | "&&" | "==" | "!=" | "<=" | ">=" | "=" | "<" | ">" | "!"
           | "+" | "-" | "*" | "/" | "%" | "(" | ")" | "[" | "]" | "{" | "}"
           | "," | ";" | ":" | "." ;
EOF        = end of source ;
```

- `INT` is a run of decimal digits (leading zeros allowed; `007` is 7). Its value must be at most 9007199254740991 (2^53 − 1); a larger literal is a lexical error. There is no negative literal: `-5` is the unary operator applied to `5`.
- A `STRING` denotes the characters between the quotes, with each escape replaced by the character it names (LF, tab, CR, `"`, `\`).
- The builtin names `print len push keys sleep fetch` are ordinary identifiers (not keywords).

Lexical errors, with the position that locates each:

| Error | Position |
|---|---|
| A character that starts no token (including a lone `&` or `|`) | that character |
| A string literal not closed before LF or the end of the source | its opening `"` |
| A backslash in a string followed by anything other than `n t r " \` | that backslash |
| An `INT` above 9007199254740991 | its first digit |

The `EOF` token's position is the position just after the last character of the source (so for a source ending in LF it is column 1 of the following line; for the empty source it is line 1, column 1).

## 3. Syntax

```ebnf
program     = { statement } EOF ;

statement   = "wait" ( letStmt | simpleStmt )
            | letStmt | simpleStmt | ifStmt | whileStmt | forStmt
            | fnDecl | returnStmt ;

letStmt     = "let" IDENT "=" expr ";" ;
simpleStmt  = expr [ "=" expr ] ";" ;                 (* expression statement, or assignment *)
ifStmt      = "if" expr block [ "else" ( ifStmt | block ) ] ;
whileStmt   = "while" expr block ;
forStmt     = "for" IDENT "in" expr block ;
fnDecl      = "fn" IDENT "(" [ IDENT { "," IDENT } ] ")" block ;
returnStmt  = "return" [ expr ] ";" ;
block       = "{" { statement } "}" ;

expr        = orExpr ;
orExpr      = andExpr   { "||" andExpr } ;
andExpr     = eqExpr    { "&&" eqExpr } ;
eqExpr      = relExpr   { ( "==" | "!=" ) relExpr } ;
relExpr     = addExpr   { ( "<" | "<=" | ">" | ">=" ) addExpr } ;
addExpr     = mulExpr   { ( "+" | "-" ) mulExpr } ;
mulExpr     = unaryExpr { ( "*" | "/" | "%" ) unaryExpr } ;
unaryExpr   = ( "-" | "!" ) unaryExpr | postfixExpr ;
postfixExpr = primary { call | index | field } ;
call        = "(" [ expr { "," expr } ] ")" ;
index       = "[" expr "]" ;
field       = "." IDENT ;
primary     = INT | STRING | "true" | "false" | "nil" | IDENT
            | "(" expr ")" | arrayLit | recordLit ;
arrayLit    = "[" [ expr { "," expr } ] "]" ;
recordLit   = "{" [ IDENT ":" expr { "," IDENT ":" expr } ] "}" ;
```

Every statement that is not a compound statement (`if`, `while`, `for`, `fn`) ends with `;`. There is no trailing comma in argument lists, array literals or record literals. A statement that begins with `{` is an expression statement whose expression is a record literal; blocks appear only where the grammar shows them. `wait` is a keyword that may prefix only a `let` statement or a simple statement.

### Precedence and associativity

From lowest to highest binding:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `\|\|` | left |
| 2 | `&&` | left |
| 3 | `==` `!=` | left |
| 4 | `<` `<=` `>` `>=` | left |
| 5 | `+` `-` (binary) | left |
| 6 | `*` `/` `%` | left |
| 7 | `-` `!` (unary, prefix) | right |
| 8 | call `( )`, index `[ ]`, field `.name` | left (applied in source order) |

So `1 < 2 < 3` is `(1 < 2) < 3`, `-a.b[0]` is `-((a.b)[0])`, and `f(1)(2)` calls the result of `f(1)`.

### Grammar errors

If the lexically valid token sequence is not a prefix of any sentence of `program`, the reported `SyntaxError` is at the last token of the shortest such non-prefix: the first token that cannot validly continue what precedes it. If that token is `EOF` its position is the `EOF` position of section 2. A lexical error and a grammar error compete by position: the one that comes first in the source is reported (tokens are produced only as far as reading requires). Section 4's errors are reported only for a source with no lexical or grammar error.

## 4. Scopes and static rules

### 4.1 Scopes

A **scope** is created by: the whole program (the *program scope*); each execution of a `block` that is the body of `if`, `else`, `while`, or `for` (a fresh scope for every execution, so every loop iteration has its own); and each call of a function (the function body's statements are in the same scope as the parameters). Scopes nest lexically; the outermost scope around the program scope holds the six builtins `print len push keys sleep fetch`.

A scope **declares** these names: every `let` name whose statement is directly in that scope's statement list (not in a nested block), every `fn` name directly in that list, every parameter (for a function scope) and the loop variable (for a `for` body scope).

Resolution is lexical: an identifier occurrence refers to the declaration of that name in the innermost enclosing scope that declares it, wherever in that scope the declaration sits; if no scope declares it (builtins included) the occurrence is **unresolved**. Declarations are of kinds: *builtin*, *fn*, and *variable* (`let`, parameter, loop variable). The `for` iterable expression is resolved in the scope that contains the `for` statement (the loop variable is not visible in it). A `let` initializer is resolved in the scope containing the `let`, where the name being declared is itself already declared.

A binding is **initialized** when: a `let` statement finishes executing; a parameter or loop variable receives its value; or, for a `fn` declaration, at the moment its scope begins executing (declarations are hoisted: on entering a scope, before any of its statements runs, every `fn` declaration directly in its statement list is bound, in source order, to a new closure that captures that scope). Reading or assigning a binding that exists but is not yet initialized, or an unresolved name, is a `RuntimeError` at the identifier token. A `let` of an existing name in an outer scope declares a new, shadowing variable in the current scope.

### 4.2 Static errors

These are reported as `SyntaxError`s. If several occur, the one with the smallest position (line, then column) is reported.

| Rule | Position |
|---|---|
| The left side of `=` is not a valid target. Valid: a bare `IDENT` primary with no suffix; or a `postfixExpr` whose last suffix is `index` or `field` (so `a[0]`, `r.f`, `f(x).y`, `(a).y` are valid; `(a)`, `f(x)`, `a + b`, `-a` are not) | the `=` token |
| A name is declared more than once in one scope (by `let`, `fn`, a parameter or the loop variable, in any combination; a function's parameters and its body statements share one scope, as do a loop variable and its body statements) | the name token of the later declaration in source order |
| A bare-identifier assignment target resolves to a *fn* or *builtin* declaration | the identifier |
| `return` outside any function body | the `return` token |
| A record literal repeats a field name | the later field name token |

An unresolved name is not a static error; it is a `RuntimeError` when evaluated.

## 5. Values

| Type | Notes |
|---|---|
| integer | exact mathematical integer with `-9007199254740991 ≤ n ≤ 9007199254740991`. There is one zero. Any operation whose exact result is outside this range is a `RuntimeError`. |
| string | sequence of UTF-16 code units. Strings are immutable. |
| boolean | `true`, `false` |
| nil | `nil` |
| array | ordered, mutable, indices `0..len-1`; a heap object |
| record | mutable map from field names to values, with insertion order; a heap object |
| function | a closure (a `fn` declaration plus the scope it captured), or a builtin |

Arrays and records are shared by reference: assigning or passing one does not copy it.

### 5.1 Display

`display(v)` is used by `print`. A string at the top level is shown as its characters. Everywhere else:

| Value | Display |
|---|---|
| integer | decimal digits, `-` prefix if negative, no `+`, no leading zeros (`0` for zero) |
| string, top level | its characters unchanged |
| string, inside an array or record | `"` + characters, with `\`→`\\`, `"`→`\"`, LF→`\n`, tab→`\t`, CR→`\r` + `"` |
| `true` `false` `nil` | `true` `false` `nil` |
| array | `[` + elements' displays joined by `", "` + `]`; empty is `[]` |
| record | `{` + `name: display` entries joined by `", "` + `}`, in insertion order; empty is `{}` |
| closure | `<fn NAME>` where NAME is the declared name |
| builtin | `<builtin NAME>` |

### 5.2 Equality

`a == b` is `true` when: both integers, both strings, or both booleans and equal; both `nil`; both arrays of equal length with pairwise-equal elements; both records with the same set of field names (order is irrelevant) and pairwise-equal values; both functions and the same closure (the same execution of the same `fn` declaration) or the same builtin. Values of different types are never equal (no error). `a != b` is `!(a == b)`.

## 6. Evaluation

Evaluation order is left to right everywhere, and every operand is evaluated before the operation's checks.

### 6.1 Operators

| Expression | Rule |
|---|---|
| `a + b` | both integers: sum; both strings: concatenation; any other combination is a `RuntimeError` |
| `a - b`, `a * b` | both integers, else `RuntimeError` |
| `a / b` | both integers, else `RuntimeError`; `b == 0` is a `RuntimeError`; the quotient is truncated toward zero (`-7 / 2` is `-3`) |
| `a % b` | both integers, else `RuntimeError`; `b == 0` is a `RuntimeError`; the result is `a - (a / b) * b` with the truncating `/` (`-7 % 3` is `-1`, `7 % -2` is `1`) |
| `a < b`, `a <= b`, `a > b`, `a >= b` | both integers (numeric order) or both strings (lexicographic order of UTF-16 code units, shorter prefix first); any other combination is a `RuntimeError` |
| `a == b`, `a != b` | section 5.2 |
| `-a` | `a` integer, else `RuntimeError` |
| `!a` | `a` boolean, else `RuntimeError` |
| `a && b` | evaluate `a`; if it is not a boolean: `RuntimeError`; if `false`, the result is `false` and `b` is not evaluated; otherwise evaluate `b`; if it is not a boolean: `RuntimeError`; the result is `b` |
| `a \|\| b` | evaluate `a`; if not a boolean: `RuntimeError`; if `true`, the result is `true` and `b` is not evaluated; otherwise evaluate `b`; if not a boolean: `RuntimeError`; the result is `b` |

### 6.2 Literals, index, field

- `[e1, …, en]`: evaluates `e1…en`, then creates a new array (one allocation). `{n1: e1, …}`: evaluates the field expressions in order, then creates a new record (one allocation) with fields in that order.
- `a[i]`: evaluates `a`, then `i`; `a` must be an array and `i` an integer with `0 ≤ i < len(a)`, else `RuntimeError`. Strings and records cannot be indexed.
- `r.f`: `r` must be a record that has field `f`, else `RuntimeError`.

### 6.3 Calls

`callee(arg1, …, argn)`: evaluate `callee`, then the arguments left to right; then the callee must be a function (else `RuntimeError`) and `n` must equal its parameter count (else `RuntimeError`; builtins have the counts in section 7). Then:

- User function: a new scope (parent: the closure's captured scope) is created with the parameters initialized to the argument values, its `fn` declarations are hoisted, and the body statements run. The call's value is that of the first `return` executed, or `nil` if the body ends without one (`return;` returns `nil`).
- Call depth: the depth of a user-function call is 1 plus the number of user-function calls active in the chain of callers that led to it (the program itself has depth 0). A call of depth greater than 200 is a `RuntimeError` (raised before the callee's scope is created).
- Every call may wait (a callee may call `sleep` or `fetch`); a caller always continues only after the callee has returned.

### 6.4 Statements

- `let x = e;` evaluates `e`, then initializes `x` in the current scope.
- `x = e;` evaluates `e`, then stores it into the binding `x` resolves to (it must be an initialized variable).
- `a[i] = e;` evaluates `a`, then `i`, then `e`; then `a` must be an array and `i` an integer with `0 ≤ i < len(a)`, else `RuntimeError`; then stores. It cannot grow the array.
- `r.f = e;` evaluates `r`, then `e`; then `r` must be a record, else `RuntimeError`; then sets field `f`, which is appended to the insertion order if it did not exist.
- `e;` evaluates `e` and discards the result.
- `if c { … } else …`: `c` must be a boolean, else `RuntimeError`.
- `while c { … }`: evaluates `c` before each iteration; `c` must be a boolean each time, else `RuntimeError`.
- `for x in e { … }`: `e` is evaluated once and must be an array, else `RuntimeError`. The iteration index starts at 0; before each iteration the array's *current* length is read, and the loop ends when the index reaches it (elements pushed during the loop are visited). Each iteration runs the body in a fresh scope in which `x` is initialized to the element at the index. The array is kept alive (section 10) until the loop ends.
- `return e;` ends the enclosing function call with that value.
- `fn` declarations bind at scope entry (section 4.1); executing the statement itself does nothing.
- `wait` has no effect other than on concurrency (section 9).

## 7. Builtins

Arguments are evaluated first; then the argument count is checked, then the types; every failure is a `RuntimeError` at the call's `(` token.

| Call | Arity | Behavior |
|---|---|---|
| `print(v)` | 1 | appends `display(v)` to `output` (section 9 for ordering); returns `nil` |
| `len(x)` | 1 | string: its length in UTF-16 code units; array: element count; record: field count; anything else `RuntimeError` |
| `push(arr, v)` | 2 | `arr` must be an array; appends `v`; returns `nil` |
| `keys(rec)` | 1 | `rec` must be a record; returns a new array (one allocation) of the field names as strings, in insertion order |
| `sleep(ms)` | 1 | `ms` must be an integer `≥ 0`, else `RuntimeError`; awaits `clock.sleep(ms)`; returns `nil` |
| `fetch(key)` | 1 | `key` must be a string, else `RuntimeError`; if `options.io` has no own property `key`, `RuntimeError` (no sleep happens); otherwise awaits `clock.sleep(io[key].latencyMs)`, then returns the Ripple value for `io[key].value`: a fresh copy, with one allocation for each array and each record in it (nested ones included); `nil` for `null` |

## 8. Asynchrony

All of this section is determined from the program text alone, before it runs.

- A **call by name** is a call whose callee is a bare `IDENT` that resolves to a *fn* or *builtin* declaration. Every other call (callee is a variable, a parenthesized expression, a call result, a field, an index, an unresolved name…) is **opaque**.
- The builtins `sleep` and `fetch` are asynchronous. A user function `F` is **asynchronous** if its body contains (outside the bodies of `fn` declarations nested inside it, which are separate functions) a call by name to `sleep`, `fetch`, or to an asynchronous function. This is the least solution of that definition (mutual recursion alone does not make functions asynchronous).
- `reach(F)` is `F` together with every function it calls by name, directly or transitively (builtins are not functions in `reach`).
- Inside a function `G`, a name occurrence is **local** if it resolves to a *variable* declaration made inside `G` (a parameter, or a `let` or loop variable in `G`'s own scopes, excluding scopes of `fn`s nested in `G`); a **non-local variable occurrence** is one that resolves to a *variable* declaration outside `G`, or is unresolved. Occurrences resolving to *fn* or *builtin* declarations are neither.
- A **mutation** is an index assignment, a field assignment, or a call by name to `push`. Its **root** is the leftmost identifier of the target expression (for `push`, of its first argument), provided that expression is an `IDENT` followed only by index and field suffixes; any other target has no root.
- A function `F` is **contained** if, for every `G` in `reach(F)`:
  1. `G` contains no opaque call;
  2. no bare-identifier assignment in `G` targets a non-local variable occurrence;
  3. every mutation in `G` has a root, and that root is local;
  4. if some function in `reach(F)` contains a mutation, no function in `reach(F)` contains a non-local variable occurrence.

## 9. Automatic concurrency

### 9.1 Candidates and runs

A statement in a statement list is a **candidate** if it has no `wait` prefix and is one of

- `f(args);`
- `let x = f(args);`

where `f` is a bare identifier that is `sleep`, `fetch`, or resolves to a *fn* declaration of a function that is asynchronous and contained, and no argument expression contains a call expression (any nesting). A **run** is a maximal sequence of consecutive candidates in one statement list. Any other statement, including a `fn` declaration or a `wait`-prefixed statement, ends a run. A `wait`-prefixed statement is executed alone, one at a time, and no run extends across it. A run of one statement, and every statement outside a run, is executed one at a time, in order.

### 9.2 Independence

The statements of a run of two or more are **members**. For a member:

- `defines` is `{x}` for `let x = …;` and empty for `f(args);`.
- `uses` is the set of identifier names that occur in the member (the callee name and every name in the arguments), together with, when the callee is a user function `F`, every name that occurs in a function of `reach(F)` as an occurrence that resolves outside the function it occurs in, other than to a builtin, or does not resolve at all. A builtin callee adds nothing beyond its own name and the argument names.

Two members are **independent** if neither's `defines` intersects the other's `defines` or `uses` (comparison by name). The run is executed concurrently only if all pairs of members are independent and the argument condition below holds; otherwise all its members are executed one at a time, in order.

### 9.3 Concurrent execution

When execution reaches a run of two or more members:

1. If the members are not all pairwise independent, execute them one at a time.
2. Otherwise, for each member in order, evaluate its argument expressions left to right. If an evaluation raises a `RuntimeError`, the evaluation of that member's arguments stops and that error becomes that member's failure; the member is not called. Values already computed stay computed. These evaluations have no effect other than possible heap allocation (array and record literals) and these errors, and they happen for all members even if an earlier member fails later.
3. If any argument value computed in step 2 is an array or a record, execute the members one at a time, in order, using the already computed argument values (not evaluating them again); a member with a recorded failure raises it when its turn comes.
4. Otherwise start the members: in source order, each begins running at once, without waiting for another member to finish or to reach an await. All members begin at the same `clock` instant, so their sleeps overlap in clock time. Each member's callee call behaves as a call from section 6.3 (including the arity check, which is raised as that member's failure). The run ends when every member has finished (completed or failed); a failed member does not stop the others.
5. When the run ends: if no member failed, each `let x = f(args)` member initializes `x` with its call's value, in source order. If a member failed, the earliest failing member in source order supplies the program's `RuntimeError`.

The result is the same as executing the members one at a time, in order, with respect to `output` and the final value of every variable.

### 9.4 Output of concurrent members

During step 4 each member's `print` output (including output of calls nested inside it) is collected separately. When the run ends, the collected outputs are appended to `output` member by member in source order. If a member failed, only the outputs of the members up to and including the earliest failing member are appended (the failing member's own output printed before its failure is kept); outputs of later members are dropped. Output of the program before the run is unchanged.

Concurrency nests: a member's own body may contain runs, and the same rules apply inside it.

## 10. Heap

- Every array and every record is a heap object. The only operations that create one: an array literal, a record literal (each: 1, once all its element/field expressions have been evaluated), `keys` (1), and `fetch` (1 per array and per record in the value it returns). Nothing else allocates. `heap.allocs` is the number of creations performed over the whole run (including creations by members whose output was dropped, and by argument evaluation in section 9.3 step 2).
- An object is **freed** (adds 1 to `heap.frees`, once) as soon as nothing can reach it. Reachable means reachable by following references from any of: a variable binding in a scope that is active (a scope being executed, or the captured scope of a reachable closure, together with all its variables and its parent scopes); a value held in an array or record that is reachable; a value in a function-call or evaluation that is in progress (operands, arguments already evaluated, a pending call's arguments and return value, a `for` loop's array, argument values of a member of a run). A closure reaches the scope it captured.
- A freed object is never read or written again.
- Test programs do not store an array or record into itself, directly or indirectly; the behavior of such a program is not defined here.
- When `run` returns, on success or on error, `heap.frees` equals `heap.allocs` (everything still reachable when the program ends or stops is freed).

## 11. Runtime error positions

Execution stops at the first `RuntimeError`. The position is that of one token:

| Error arises from | Position |
|---|---|
| a read of an uninitialized or unresolved name, an assignment to one | the identifier |
| a unary or binary operator, including `&&` and `\|\|` (type error, division or modulo by zero, integer overflow) | the operator token |
| a call: callee not a function, wrong argument count, a builtin's argument error or failure (including unknown `fetch` key), call depth over 200 | the call's `(` token |
| indexing, index assignment (type, bounds) | the `[` token |
| field read, field assignment (not a record, missing field) | the `.` token |
| `if` / `while` condition not a boolean | the first token of the condition expression |
| `for` iterable not an array | the first token of the iterable expression |

An error raised inside a function is located in the function's source text, in the same way. Errors in the program text of section 2, 3 and 4 locate as stated there.

## 12. Examples

In examples, `output` is shown one entry per line.

### 12.1 Arithmetic, display, loops

```
let x = 7;
let y = -2;
print(x / y);
print(x % y);
print("n=" + "7");
print([1, "a\"b", true, nil, [2], {k: 3}]);
let items = [];
let i = 0;
while i < 4 {
  push(items, i * i);
  i = i + 1;
}
let sum = 0;
for v in items { sum = sum + v; }
print(items);
print(sum);
```

output:

```
-3
1
n=7
[1, "a\"b", true, nil, [2], {k: 3}]
[0, 1, 4, 9]
14
```

`error` is `null`; `heap` is `{ allocs: 4, frees: 4 }` (the outer array, `[2]` and `{k: 3}` of the fourth `print`, and `items`).

### 12.2 Closures and recursion

```
fn fact(n) {
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
print(tick);
```

output:

```
2
3628800
<fn next>
```

`heap` is `{ allocs: 1, frees: 1 }` (`cells`, kept alive by the closure `next` until the program ends).

### 12.3 Records

```
let r = {b: 2, a: 1};
r.c = r.a + r.b;
for k in keys(r) {
  print(k);
}
print(r);
print(len(r) == 3 && r.c == 3);
```

output:

```
b
a
c
{b: 2, a: 1, c: 3}
true
```

`heap` is `{ allocs: 2, frees: 2 }` (the record and the array made by `keys`).

### 12.4 Errors

| Source | `error` |
|---|---|
| `let x = ;` | `SyntaxError`, line 1, column 9 (the `;`) |
| `if true {` | `SyntaxError`, line 1, column 10 (`EOF`) |
| `print("abc);` | `SyntaxError`, line 1, column 7 (the opening `"`) |
| `let a = 1;`⏎`let a = 2;` | `SyntaxError`, line 2, column 5 (the second `a`) |
| `1 + 2 = 3;` | `SyntaxError`, line 1, column 7 (the `=`) |
| `let a = [1, 2];`⏎`print(a[2]);` | `RuntimeError`, line 2, column 8 (the `[`); `output` is `[]`; `heap` is `{ allocs: 1, frees: 1 }` |
| `print(1);`⏎`print(1 / 0);` | `RuntimeError`, line 2, column 9 (the `/`); `output` is `["1"]` |

### 12.5 Concurrency (times are `clock` time elapsed during the run)

Every example here defines

```
fn slow(label, ms) {
  sleep(ms);
  print(label);
  return ms;
}
```

`slow` is asynchronous and contained.

**Independent members run concurrently.** Elapsed time 300. `slow("b", 100)` finishes first, but output is grouped in source order:

```
let a = slow("a", 300);
let b = slow("b", 100);
print(a + b);
```

output: `a`, `b`, `400`.

**Dependent members run one at a time** (the second reads `a`, which the first defines). Elapsed time 600:

```
let a = slow("a", 300);
let b = slow("b", a);
print(a + b);
```

output: `a`, `b`, `600`.

**`wait` runs a statement alone.** Elapsed time 300:

```
let a = slow("a", 100);
wait let b = slow("b", 100);
let c = slow("c", 100);
print(a + b + c);
```

output: `a`, `b`, `c`, `300`.

**A failing member.** With

```
fn slow(label, ms) {
  sleep(ms);
  print(label);
  return ms;
}
fn boom(ms) { sleep(ms); print("boom"); return 1 / 0; }
let a = slow("a", 100);
let b = boom(50);
let c = slow("c", 10);
print("unreachable");
```

all three members start together and the run ends when all have finished (elapsed 100). `b` is the earliest failing member. `output` is `["a", "boom"]` (`c`'s output is dropped and `print("unreachable")` never runs). `error` is a `RuntimeError` at line 6, column 50 (the `/`).

**Array arguments run one at a time.** Elapsed time 20:

```
fn show(items) { sleep(10); print(len(items)); }
let list = [1, 2];
show(list);
show(list);
```

output: `2`, `2`. `heap` is `{ allocs: 1, frees: 1 }`.

**A function that mutates a non-local is not contained.** Elapsed time 20:

```
let total = [0];
fn add(n) { sleep(10); total[0] = total[0] + n; }
add(1);
add(2);
print(total[0]);
```

output: `3`.

**`fetch` runs concurrently with the clock.** With `io = { user: { value: { name: "ana" }, latencyMs: 40 }, posts: { value: [1, 2, 3], latencyMs: 70 } }`, elapsed time 70:

```
let user = fetch("user");
let posts = fetch("posts");
print(user.name);
print(len(posts));
```

output: `ana`, `3`. `heap` is `{ allocs: 2, frees: 2 }`.
