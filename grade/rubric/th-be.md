# Rubric: th-be (Ripple interpreter)

A reviewer answers each item **yes** or **no** from reading the solution under `tasks/th-be/`. Each item covers something the hidden tests and the gates (duct-tape, swallowed-error, sql-injection, duplication) cannot judge. One point per yes; no half points. Cite the file and line behind every answer.

"Library rule" names the protocol in the agent rules; "Spec" names a section of `tasks/th-be/SPEC.md`.

| # | Item (answer yes or no) | Source |
|---|---|---|
| 1 | Are the lexer, the parser, the static analysis (scopes, resolution, static errors) and the evaluator separate modules, each holding one concern, with `src/index.ts` only wiring them into `run`? (One file holding two or more of these is a no.) | Library: Code Organisation Protocol |
| 2 | Do the modules talk only through exported functions and types (tokens, syntax tree, analysis result)? (The evaluator reaching into the lexer's or parser's private state, or the parser calling the evaluator, is a no.) | Library: Code Organisation Protocol |
| 3 | Does the independence analysis (asynchronous functions, `reach`, containment, candidates, runs, `defines`/`uses`) have exactly one producer, in the analysis module, with the evaluator only reading its result and never re-deriving asynchrony, containment or independence itself? | Spec: 8, 9.1, 9.2; Library: Reuse Protocol, Root Cause Protocol (one producer) |
| 4 | Is everything of section 8 and 9.1-9.2 computed from the program text once, before execution starts, and not recomputed per call, per loop iteration or per run execution? | Spec: 8 ("determined from the program text alone, before it runs") |
| 5 | Do all errors take their line and column from the token (or syntax node built from a token) that the spec names, with no position found by searching the source text again, no hard-coded offsets and no position guessed from the previous or next token? | Spec: 2, 3, 4.2, 11; Library: Fail Fast Protocol (errors name the failure) |
| 6 | Is there one error type for Ripple's own errors (kind, message, line, column), and are internal faults (a `TypeError`, an unexpected state) never turned into a Ripple `RuntimeError` or `SyntaxError`, so that an interpreter bug cannot pass as a program error? | Spec: 1 (`error`); Library: Fail Fast Protocol (no silent fallback; errors as values across boundaries) |
| 7 | Is there no module-level mutable state: heap counters, output, scopes, the clock and caches are created per `run` call and passed or held in an object, so several `run` calls are independent? | Spec: 1 ("Several calls to `run` are independent"); Library: Code Organisation Protocol |
| 8 | Is time read and waited on only through `options.clock` (no `setTimeout`, `setInterval`, `Date.now`, `performance.now` or `Bun.sleep` anywhere under `src/`)? | Spec: 1 (clock bullet) |
| 9 | Is heap accounting (counting creations, deciding what is reachable, counting frees) in one module or one object with a small interface, rather than `allocs`/`frees` updates scattered through the evaluator? | Spec: 10; Library: Code Organisation Protocol |
| 10 | Is shared mechanical work written once: one checked-integer helper for the range rule of section 5, one operator type-check path, one position-carrying error constructor? (The same overflow check or type check copied into several operator branches is a no.) | Spec: 5, 6.1; Library: Reuse Protocol |
| 11 | Are names self-explanatory (no single letters outside the allowed list, no invented abbreviations such as `tok2`, `cfg`, `usr`), comments limited to the non-obvious why, and every function whose cost is not obvious (the asynchrony fixed point, `reach`, the free/reachability step, the concurrent-run executor) given a doc comment stating its time and space cost? | Library: Self-Documenting Code Protocol |
| 12 | Is the code free of dead code, commented-out code, unused exports, unused files, stray debug output and "for now" shortcuts (for example an array-argument or `wait` rule skipped or approximated)? | Library: No Duct Tape Protocol |

Total: 12 items. The hidden tests observe heap counts only when `run` returns, so items 3, 4 and 9 are where a reviewer checks how the solution gets there.
