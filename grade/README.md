# grade

Scores a tryout solution (`tasks/<id>/`) against hidden tests and rule gates.

```
bun grade/cli.ts <task-id> <solution-dir> [--json]
```

Exit `0` right-first-time, `1` not, `2` usage or infrastructure error (message on stderr, nothing on stdout).
Exit 2 covers: bad arguments, missing solution dir, missing/invalid `tasks/<id>.json`, missing `hidden/<id>/` (or no `*.test.ts` in it), jscpd failure.

## Steps (always all run, in this order)

1. **layout**: every `entries` file exists; `package.json` exists, is valid JSON and has no non-empty `dependencies`.
2. **typecheck**: `tsc --noEmit -p <solution-dir>` (grade's own TypeScript). If `package.json` has `devDependencies` and there is no `node_modules`, `bun install` runs in the solution first; a failed install is a typecheck error.
3. **gates** (TypeScript compiler API; `node_modules`, `dist`, `build`, `coverage` are never scanned; test files are `*.test.*`, `*.spec.*` and anything under `test/`, `tests/`, `__tests__/`):
   - `duct-tape` (tests included): upper-case `TODO|FIXME|HACK|XXX` in comments; `@ts-ignore`, `@ts-expect-error`, `eslint-disable` in comments; any `any` type.
   - `swallowed-error`: `catch` clauses and `.catch(fn)` whose body is empty or only returns a literal default (`null`, `undefined`, `void 0`, booleans, numbers, strings, `[]`, `{}`, bare `return`).
   - `sql-injection`: `.query/.prepare/.run/.exec/.all/.get/.values(sql)` whose first argument is a template with substitutions or a `+` concatenation containing a dynamic operand, **and** whose fixed text reads as SQL (`select|insert|update|delete|create|drop|alter|pragma|replace|where|from|into`). The keyword check keeps `map.get(\`user:${id}\`)` clean. Tagged templates and a `const sql` passed by name are not flagged.
   - `duplication`: jscpd, `--min-tokens` from config (default 60), tests excluded.
4. **tests**: each `hidden/<id>/**/*.test.ts` runs in its own `bun test` process (sequentially: they share one solution) with env `SOLUTION_DIR` (absolute) and JUnit output. Skipped/todo tests, files that fail to load and files that time out (120 s) count as failures.

## Task config: `tasks/<id>.json`

```json
{
  "entries": ["src/app.ts", "src/main.ts"],
  "gates": ["duct-tape", "swallowed-error", "sql-injection", "duplication"],
  "duplication": { "minTokens": 60 }
}
```

Only `entries` is required. `gates` (default: all four) lists the gates that apply. Unknown keys and gate ids are rejected.

## `--json` output

```
{ task, solutionDir, layout: {pass, findings}, typecheck: {pass, errors},
  gates: [{ id, pass, findings: [{ file, line, message }] }],
  tests: { passed, failed, total, failures: [name] }, rightFirstTime }
```

`file` is relative to the solution dir; `line` is 1-based. Findings are sorted by file, line, message. `rightFirstTime` = layout, typecheck and every gate pass, and `tests.failed === 0 && tests.total > 0`.

## Development

`bun test` (grader's own tests only, see `bunfig.toml`). `selftest/<case>/` are tiny solutions for the `selftest` task (`tasks/selftest.json`, `hidden/selftest/`); `pass` passes, every other case breaks one thing:

```
for c in pass duct-tape swallowed-error sql-injection duplication layout typecheck tests; do
  bun grade/cli.ts selftest grade/selftest/$c --json
done
```
