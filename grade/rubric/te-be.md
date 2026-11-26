# Rubric: te-be (Budget API)

A reviewer answers each item **yes** or **no** from reading the solution under `tasks/te-be/`. Each item covers something the hidden tests and the gates (duct-tape, swallowed-error, sql-injection, duplication) cannot judge. One point per yes; no half points. Cite the file and line behind every answer.

"Library rule" names the protocol in the agent rules; "Spec" names a section of `tasks/te-be/SPEC.md`.

| # | Item (answer yes or no) | Source |
|---|---|---|
| 1 | Does each file under `src/` hold one concern, with request routing, input validation, SQLite persistence, and the summary/calendar calculation in separate modules, and `app.ts` only wiring them together? (A single file holding two or more of these is a no.) | Library: Code Organisation Protocol |
| 2 | Do modules reach each other only through exported functions or types? (No module imports another's private state, and no handler uses a raw `Database` handle that the persistence module owns.) | Library: Code Organisation Protocol |
| 3 | Is every request body field and path value validated in one place at the edge, before any database call, so persistence and calculation code never receives an unchecked value? | Library: Fail Fast Protocol (validate where input enters); Spec: Order of checks, step 4 |
| 4 | Do the validation, lookup and persistence modules report expected failures (invalid input, missing user, duplicate budget, no budget) as returned values rather than by throwing across a module boundary, with thrown database errors caught and turned into `500 internal_error` at one place? | Library: Fail Fast Protocol (errors as values) |
| 5 | Does the `500 internal_error` response carry a fixed generic message, never the caught error's message, stack or SQL? | Spec: Errors (500 row); Library: Secure Code Protocol |
| 6 | Are all SQL values bound parameters, including values passed through helpers, constants or a shared query function the sql-injection gate cannot see? | Library: Secure Code Protocol |
| 7 | Is all time zone and calendar arithmetic (local month, `daysLeft`, month membership of a spend) in one module using standard `Intl`/`Date` APIs, with no hand-written offset tables, and is `now()` called once per summary request with that one instant passed down? | Spec: `createApp` (`now` bullet), GET summary; Library: Reuse Protocol |
| 8 | Is shared mechanical work written once: one category check used by budgets and spends, one integer-in-range check used for `limitCents` and `amountCents`, one JSON error-response builder? (Copies of the same check in two handlers is a no.) | Library: Reuse Protocol |
| 9 | Are names self-explanatory (no single letters outside the allowed list, no invented abbreviations such as `usr`, `cfg`, `req2`), comments limited to the non-obvious why, and the summary calculation given a doc comment stating its time and space cost? | Library: Self-Documenting Code Protocol |
| 10 | Is the code free of dead code, commented-out code, unused exports, unused files and stray debug output? | Library: No Duct Tape Protocol |
| 11 | Are there tests of the right kind and tier: unit tests for the pure logic (the `spentAt` parser, the category/integer validators, the calendar and allowance calculation) and at least one test driving `createApp(...).fetch` end to end with an injected `now` and a temp or in-memory database, with no real-clock or timing dependence? | Library: Testing Coder Protocol (High-tier unit tests); Spec: Stack and files |
| 12 | Is `src/main.ts` thin and as specified: it only reads `PORT` (default `3000`) and `DB_PATH` (default `budget.db`), calls `createApp`, and serves `app.fetch` with `Bun.serve`? | Spec: `src/main.ts`; Library: Code Organisation Protocol (thin entry point) |

Total: 12 items. Hidden tests do not run `startServer`, so item 12 is the only check of `main.ts`.
